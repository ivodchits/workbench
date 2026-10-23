// The phone's fallback brain (H7): when Workbench can't be reached, the app's
// page runs Duck's engine itself (`src/pwa/phoneBrain.ts`) and calls the API
// through here, with the phone's own key. The key never reaches the page: the
// page's SDK sends its requests to `api_fetch`, which adds the key, streams the
// answer back over a channel, and counts what it cost against the month's cap.
//
// - Only `POST /v1/messages` goes out, to api.anthropic.com.
// - At the cap, a request is refused with the desktop proxy's own 402
//   (`budget_exceeded`), so the engine says so the same way.
// - The ledger is per calendar month, priced like the desktop's `usage.rs`.
//
// `Speech`: the reply said aloud with the phone's own text-to-speech.

package com.workbench.duck

import android.content.Context
import android.speech.tts.TextToSpeech
import app.tauri.plugin.Channel
import app.tauri.plugin.JSObject
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDate
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

object PhoneBrain {
  const val DEFAULT_CAP = 5.0
  private const val API = "https://api.anthropic.com"
  private val PATHS = setOf("/v1/messages")
  /** Headers the page may not set: the key is the app's, the purpose is the
   *  desktop proxy's own. */
  private val DROPPED = setOf("x-api-key", "authorization", "x-wb-purpose", "host", "content-length")

  private val pool = Executors.newCachedThreadPool()
  private val open = ConcurrentHashMap<String, HttpURLConnection>()

  // ── prices, USD per million tokens (from `src-tauri/src/assistant/usage.rs`) ──

  private class Price(val input: Double, val write5m: Double, val write1h: Double, val read: Double, val output: Double)

  private val PRICES = listOf(
    "claude-fable-5-1" to Price(10.0, 12.5, 20.0, 0.25, 50.0),
    "claude-fable-5" to Price(10.0, 12.5, 20.0, 1.0, 50.0),
    "claude-opus-5-5" to Price(4.0, 5.0, 8.0, 0.20, 20.0),
    "claude-opus-5" to Price(5.0, 6.25, 10.0, 0.50, 25.0),
    "claude-sonnet-5-5" to Price(2.0, 2.5, 4.0, 0.10, 10.0),
    "claude-sonnet-5" to Price(2.0, 2.5, 4.0, 0.20, 10.0),
    "claude-haiku-5-5" to Price(0.10, 0.125, 0.20, 0.01, 0.50),
  )
  private val HAIKU_LONG = Price(0.50, 0.625, 1.0, 0.05, 2.50)
  private val FALLBACK = Price(10.0, 12.5, 20.0, 1.0, 50.0)

  /** What one request cost, from its model and final `usage`. */
  fun cost(model: String, usage: JSONObject): Double {
    val input = usage.optLong("input_tokens")
    val read = usage.optLong("cache_read_input_tokens")
    val cc = usage.optJSONObject("cache_creation")
    val w1h = cc?.optLong("ephemeral_1h_input_tokens") ?: 0L
    val w5m = cc?.optLong("ephemeral_5m_input_tokens") ?: usage.optLong("cache_creation_input_tokens")
    val output = usage.optLong("output_tokens")
    var p = PRICES.firstOrNull { model.startsWith(it.first) }?.second ?: FALLBACK
    if (model.startsWith("claude-haiku-5-5") && input + read + w5m + w1h > 100_000) p = HAIKU_LONG
    return (input * p.input + w5m * p.write5m + w1h * p.write1h + read * p.read + output * p.output) / 1_000_000.0
  }

  // ── the month's spend ──

  private fun month() = LocalDate.now().toString().substring(0, 7)

  /** `{month, usd, requests, cap}`: this month's spend with the phone key. */
  @Synchronized
  fun spend(ctx: Context): JSONObject {
    val s = JSONObject(Store.get(ctx, "phoneSpend") ?: "{}")
    val now = month()
    val fresh = s.optString("month") != now
    return JSONObject()
      .put("month", now)
      .put("usd", if (fresh) 0.0 else s.optDouble("usd", 0.0))
      .put("requests", if (fresh) 0 else s.optInt("requests", 0))
      .put("cap", Store.settings(ctx).optDouble("phoneCap", DEFAULT_CAP))
  }

  @Synchronized
  private fun add(ctx: Context, usd: Double) {
    val s = spend(ctx)
    Store.put(
      ctx,
      "phoneSpend",
      JSONObject().put("month", s.getString("month")).put("usd", s.getDouble("usd") + usd).put("requests", s.getInt("requests") + 1).toString(),
    )
  }

  // ── a request ──

  /** One request: `head` `{status, headers}` first, then `chunk`s of the body,
   *  then `end`; or `fail` before the head. Runs off the main thread. */
  fun fetch(ctx: Context, id: String, path: String, headers: JSONObject, body: String, channel: Channel, done: (String?) -> Unit) {
    pool.execute {
      try {
        if (path !in PATHS) return@execute done("the phone brain only sends messages")
        val key = Store.phoneKey(ctx) ?: return@execute done("there's no phone key: set one in Duck's settings")
        val s = spend(ctx)
        if (s.getDouble("usd") >= s.getDouble("cap")) {
          val msg = "The phone key's cap for the month ($%.2f) is used up. It can be raised in Duck's settings.".format(Locale.US, s.getDouble("cap"))
          channel.send(JSObject().put("head", JSObject().put("status", 402).put("headers", JSObject().put("content-type", "application/json"))))
          channel.send(JSObject().put("chunk", JSONObject().put("type", "error").put("error", JSONObject().put("type", "budget_exceeded").put("message", msg)).toString()))
          channel.send(JSObject().put("end", true))
          return@execute done(null)
        }
        val conn = URL(API + path).openConnection() as HttpURLConnection
        open[id] = conn
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 15_000
        conn.readTimeout = 120_000
        headers.keys().forEach { k -> if (k.lowercase() !in DROPPED) conn.setRequestProperty(k, headers.getString(k)) }
        conn.setRequestProperty("x-api-key", key)
        conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        val status = conn.responseCode
        val head = JSObject()
        conn.headerFields.forEach { (k, v) -> if (k != null && v.isNotEmpty()) head.put(k.lowercase(), v.joinToString(", ")) }
        channel.send(JSObject().put("head", JSObject().put("status", status).put("headers", head)))
        val stream = (if (status >= 400) conn.errorStream else conn.inputStream) ?: run {
          channel.send(JSObject().put("end", true))
          return@execute done(null)
        }
        var model = ""
        var usage: JSONObject? = null
        BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { r ->
          val block = StringBuilder()
          while (true) {
            val line = r.readLine() ?: break
            block.append(line).append('\n')
            if (line.startsWith("data: ") && line.contains("\"usage\"")) {
              try {
                val e = JSONObject(line.substring(6))
                when (e.optString("type")) {
                  "message_start" -> e.optJSONObject("message")?.let { m ->
                    model = m.optString("model", model)
                    usage = m.optJSONObject("usage")
                  }
                  "message_delta" -> e.optJSONObject("usage")?.let { u ->
                    val base = usage ?: JSONObject()
                    u.keys().forEach { k -> if (!u.isNull(k)) base.put(k, u.get(k)) }
                    usage = base
                  }
                }
              } catch (_: Exception) {
                // not JSON: passed on as it came
              }
            }
            // One SSE event a message on the channel.
            if (line.isEmpty()) {
              channel.send(JSObject().put("chunk", block.toString()))
              block.setLength(0)
            }
          }
          if (block.isNotEmpty()) channel.send(JSObject().put("chunk", block.toString()))
        }
        usage?.let { add(ctx, cost(model, it)) }
        channel.send(JSObject().put("end", true))
        done(null)
      } catch (e: Exception) {
        if (open.containsKey(id)) done(e.message ?: e.toString()) else done("stopped")
      } finally {
        open.remove(id)?.disconnect()
      }
    }
  }

  /** Stop request `id` (the page's AbortSignal). */
  fun abort(id: String) {
    open.remove(id)?.let { c -> pool.execute { c.disconnect() } }
  }
}

/** The reply said aloud with the phone's own text-to-speech (H7: the
 *  desktop's voices aren't there offline). */
object Speech {
  private var tts: TextToSpeech? = null
  private var ready = false
  private val waiting = mutableListOf<String>()

  @Synchronized
  fun say(ctx: Context, text: String) {
    if (ready) return speak(text)
    waiting.add(text)
    if (tts == null)
      tts = TextToSpeech(ctx.applicationContext) { status ->
        synchronized(this) {
          ready = status == TextToSpeech.SUCCESS
          if (ready) waiting.forEach { speak(it) }
          waiting.clear()
        }
      }
  }

  private fun speak(text: String) {
    tts?.speak(text, TextToSpeech.QUEUE_ADD, null, "duck-${text.hashCode()}")
  }

  @Synchronized
  fun stop() {
    waiting.clear()
    tts?.stop()
  }
}

// The `duck` plugin (R4, H5): what the page (the desktop's own, `src/pwa/`, or
// the app's loader) asks of the phone, as `plugin:duck|<command>` (`native.ts`).
//
// - The phone host: `info` (the tools it offers), `run` (one call, after any
//   permission it needs and an unlock over the lock screen).
// - Keeping: `address`, the device `token` (sealed), the device key (`key_*`,
//   Keystore), the app's `settings`.
// - Ways in: `launch` (why the app opened; later ones come as `launch` events).
// - The mic: `mic_start` streams 16 kHz frames to a channel, in the conversation
//   service when `foreground`; `mic_stop`; `recognize` (the phone's own speech
//   recognizer, for when the desktop can't be reached).
// - Reminders: `reminders` arms the desktop's list; `reminder_actions` hands over
//   Done / Snooze taps (a `reminderActed` event says there are some).
// - `widget_status`: the widget's line.

package com.workbench.duck

import android.Manifest
import android.app.Activity
import android.app.KeyguardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.webkit.WebView
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

@InvokeArg
class MicArgs {
  lateinit var channel: Channel
  var foreground: Boolean = false
}

@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "mic"),
    Permission(strings = [Manifest.permission.READ_CONTACTS], alias = "contacts"),
    Permission(strings = [Manifest.permission.CALL_PHONE], alias = "phone"),
    Permission(strings = [Manifest.permission.SEND_SMS], alias = "sms"),
    Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notify"),
  ],
)
class DuckPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    @Volatile var instance: DuckPlugin? = null
      private set
    const val VERSION = 1
  }

  private val ctx: Context = activity.applicationContext
  private val tools = PhoneTools(activity)
  private val work = Executors.newSingleThreadExecutor()
  var webView: WebView? = null
    private set
  private var mic: Mic? = null

  override fun load(webView: WebView) {
    this.webView = webView
    instance = this
    ReminderAlarms.channel(ctx)
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    mic?.stop()
  }

  // ── events ──

  fun launched(launch: JSONObject) = trigger("launch", JSObject(launch.toString()))

  /** Conversation mode was stopped outside the page (the tile, the notification). */
  fun talkStopped(why: String) {
    mic?.stop()
    mic = null
    ConversationService.stop(ctx)
    trigger("talkStop", JSObject().put("why", why))
  }

  fun reminderActed() = trigger("reminderActed", JSObject())

  // ── the phone host ──

  @Command
  fun info(invoke: Invoke) {
    invoke.resolve(
      JSObject()
        .put("tools", JSArray(PhoneTools.NAMES))
        .put("version", VERSION)
        .put("locked", ctx.getSystemService(KeyguardManager::class.java).isKeyguardLocked),
    )
  }

  @Command
  fun run(invoke: Invoke) {
    val args = invoke.getArgs()
    val tool = args.getString("tool")
    val input = args.optJSONObject("input") ?: JSONObject()
    val missing = tools.needs(tool, input).filter { getPermissionState(it) != PermissionState.GRANTED }
    if (missing.isNotEmpty()) return requestPermissionForAliases(missing.toTypedArray(), invoke, "afterToolPermission")
    unlocked(invoke) { runNow(invoke, tool, input) }
  }

  @PermissionCallback
  private fun afterToolPermission(invoke: Invoke) {
    val args = invoke.getArgs()
    val tool = args.getString("tool")
    val input = args.optJSONObject("input") ?: JSONObject()
    val missing = tools.needs(tool, input).filter { getPermissionState(it) != PermissionState.GRANTED }
    if (missing.isNotEmpty()) return invoke.reject("the phone refused the ${missing.joinToString(" and ")} permission; it can be allowed in the app's settings")
    unlocked(invoke) { runNow(invoke, tool, input) }
  }

  /** Over the lock screen with "require unlock" on, ask for the unlock first. */
  private fun unlocked(invoke: Invoke, then: () -> Unit) {
    val km = ctx.getSystemService(KeyguardManager::class.java)
    if (!km.isKeyguardLocked || !Store.settings(ctx).optBoolean("requireUnlock", true)) return then()
    activity.runOnUiThread {
      km.requestDismissKeyguard(activity, object : KeyguardManager.KeyguardDismissCallback() {
        override fun onDismissSucceeded() = then()
        override fun onDismissCancelled() = invoke.reject("the phone is locked: unlock it, then ask again")
        override fun onDismissError() = invoke.reject("the phone is locked: unlock it, then ask again")
      })
    }
  }

  private fun runNow(invoke: Invoke, tool: String, input: JSONObject) {
    work.execute {
      try {
        val out = tools.run(tool, input)
        invoke.resolve(JSObject().put("output", if (out is JSONObject) JSObject(out.toString()) else out))
      } catch (e: ToolError) {
        invoke.reject(e.message)
      } catch (e: SecurityException) {
        invoke.reject("the phone didn't allow it: ${e.message}")
      } catch (e: Exception) {
        invoke.reject("$tool failed: ${e.message ?: e}")
      }
    }
  }

  // ── what the app keeps ──

  @Command
  fun address(invoke: Invoke) = invoke.resolve(JSObject().put("address", Store.get(ctx, "address")))

  @Command
  fun setAddress(invoke: Invoke) {
    Store.put(ctx, "address", invoke.getArgs().optString("address").ifEmpty { null })
    invoke.resolve()
  }

  @Command
  fun token(invoke: Invoke) = invoke.resolve(JSObject().put("token", Store.token(ctx)))

  @Command
  fun setToken(invoke: Invoke) {
    val args = invoke.getArgs()
    Store.setToken(ctx, if (args.isNull("token")) null else args.getString("token"))
    invoke.resolve()
  }

  @Command
  fun keyCreate(invoke: Invoke) {
    try {
      invoke.resolve(JSObject().put("publicKey", DeviceKey.create(ctx)))
    } catch (e: Exception) {
      invoke.reject("the Keystore didn't make a key: ${e.message}")
    }
  }

  @Command
  fun keySign(invoke: Invoke) {
    val data = invoke.getArgs().getString("data").toByteArray(Charsets.UTF_8)
    invoke.resolve(JSObject().put("signature", DeviceKey.sign(data)))
  }

  @Command
  fun keyDrop(invoke: Invoke) {
    DeviceKey.drop()
    invoke.resolve()
  }

  @Command
  fun settings(invoke: Invoke) = invoke.resolve(JSObject(Store.settings(ctx).toString()))

  @Command
  fun setSettings(invoke: Invoke) {
    val next = Store.settings(ctx)
    val args = invoke.getArgs()
    args.keys().forEach { next.put(it, args.get(it)) }
    Store.setSettings(ctx, next)
    invoke.resolve(JSObject(next.toString()))
  }

  // ── ways in ──

  @Command
  fun launch(invoke: Invoke) =
    invoke.resolve(JSObject().put("launches", JSONArray(Launches.take().map { JSONObject(it.toString()) })))

  @Command
  fun widgetStatus(invoke: Invoke) {
    Store.put(ctx, "widgetText", invoke.getArgs().optString("text"))
    Store.put(ctx, "widgetAt", System.currentTimeMillis().toString())
    DuckWidget.refresh(ctx)
    invoke.resolve()
  }

  // ── reminders ──

  @Command
  fun reminders(invoke: Invoke) {
    ReminderAlarms.arm(ctx, invoke.getArgs().optJSONArray("alarms") ?: JSONArray())
    // Showing one needs the notification permission (Android 13+): asked once here.
    if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notify") != PermissionState.GRANTED && Store.get(ctx, "askedNotify") == null) {
      Store.put(ctx, "askedNotify", "1")
      return requestPermissionForAlias("notify", invoke, "afterNotifyPermission")
    }
    invoke.resolve()
  }

  @PermissionCallback
  private fun afterNotifyPermission(invoke: Invoke) = invoke.resolve()

  @Command
  fun reminderActions(invoke: Invoke) = invoke.resolve(JSObject().put("actions", Store.takeActions(ctx)))

  // ── the mic ──

  @Command
  fun micStart(invoke: Invoke) {
    if (getPermissionState("mic") != PermissionState.GRANTED) return requestPermissionForAlias("mic", invoke, "afterMicPermission")
    startMic(invoke)
  }

  @PermissionCallback
  private fun afterMicPermission(invoke: Invoke) {
    if (getPermissionState("mic") != PermissionState.GRANTED) return invoke.reject("The mic was refused. Allow it in Duck's app settings.")
    startMic(invoke)
  }

  private fun startMic(invoke: Invoke) {
    val args = invoke.parseArgs(MicArgs::class.java)
    mic?.stop()
    try {
      if (args.foreground) {
        ConversationService.start(ctx)
        askBatteryOnce()
      }
      val channel = args.channel
      mic = Mic(
        onFrame = { channel.send(JSObject().put("pcm", it)) },
        onError = { why -> trigger("micError", JSObject().put("why", why)) },
      ).also { it.start() }
      invoke.resolve()
    } catch (e: Exception) {
      if (args.foreground) ConversationService.stop(ctx)
      invoke.reject("The mic didn't start: ${e.message}")
    }
  }

  @Command
  fun micStop(invoke: Invoke) {
    mic?.stop()
    mic = null
    ConversationService.stop(ctx)
    invoke.resolve()
  }

  /** Nothing OS stops background apps hard: ask once to be let off battery
   *  optimization, the first time conversation mode runs. */
  private fun askBatteryOnce() {
    val pm = ctx.getSystemService(PowerManager::class.java)
    if (pm.isIgnoringBatteryOptimizations(ctx.packageName) || Store.get(ctx, "askedBattery") != null) return
    Store.put(ctx, "askedBattery", "1")
    try {
      @Suppress("BatteryLife")
      activity.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}")))
    } catch (e: Exception) {
      // no such page on this phone
    }
  }

  // ── the phone's own speech recognizer ──

  @Command
  fun recognize(invoke: Invoke) {
    if (getPermissionState("mic") != PermissionState.GRANTED) return requestPermissionForAlias("mic", invoke, "afterRecognizePermission")
    recognizeNow(invoke)
  }

  @PermissionCallback
  private fun afterRecognizePermission(invoke: Invoke) {
    if (getPermissionState("mic") != PermissionState.GRANTED) return invoke.reject("The mic was refused. Allow it in Duck's app settings.")
    recognizeNow(invoke)
  }

  private fun recognizeNow(invoke: Invoke) {
    val lang = invoke.getArgs().optString("lang").ifEmpty { null }
    activity.runOnUiThread {
      val sr = Recognizers.create(ctx) ?: return@runOnUiThread invoke.reject("this phone has no speech recognizer")
      var done = false
      sr.setRecognitionListener(object : RecognitionListener {
        override fun onResults(results: Bundle?) {
          if (done) return
          done = true
          val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
          invoke.resolve(JSObject().put("text", text ?: ""))
          sr.destroy()
        }

        override fun onError(error: Int) {
          if (done) return
          done = true
          invoke.reject(if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) "nothing heard" else "the phone's recognizer failed ($error)")
          sr.destroy()
        }

        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onPartialResults(partialResults: Bundle?) {}
        override fun onEvent(eventType: Int, params: Bundle?) {}
      })
      sr.startListening(
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
          .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
          .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
          .apply { lang?.let { putExtra(RecognizerIntent.EXTRA_LANGUAGE, it) } },
      )
    }
  }
}

/** A speech recognizer that isn't Duck's own stub: the phone's on-device one, or
 *  another app's (Google's). Main thread only. */
object Recognizers {
  fun other(ctx: Context): ComponentName? =
    ctx.packageManager.queryIntentServices(Intent(RecognitionService.SERVICE_INTERFACE), 0)
      .map { ComponentName(it.serviceInfo.packageName, it.serviceInfo.name) }
      .firstOrNull { it.packageName != ctx.packageName }

  fun create(ctx: Context): SpeechRecognizer? {
    if (Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx))
      return SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx)
    val c = other(ctx) ?: return null
    return SpeechRecognizer.createSpeechRecognizer(ctx, c)
  }
}

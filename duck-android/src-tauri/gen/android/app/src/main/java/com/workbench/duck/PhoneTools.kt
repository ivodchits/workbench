// The `phone` host's tools (H5), as the engine declares them in
// `src/assistant/tools/phone.ts` (and `open_on_phone` in `media.ts`). The page
// serves them over Duck's socket (`serveHost`) and runs each here through the
// plugin's `run`. Input is checked again: a host only runs what it announced,
// with what the schema allows.
//
// Permissions are asked for when a tool first needs one (`needs`), not at
// install. Special access (notifications, Do Not Disturb) can't be asked for in
// a dialog: the tool opens its settings page and says so.

package com.workbench.duck

import android.app.Activity
import android.app.AlarmManager
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Build
import android.provider.AlarmClock
import android.provider.ContactsContract
import android.provider.Settings
import android.telephony.SmsManager
import android.view.KeyEvent
import org.json.JSONArray
import org.json.JSONObject
import java.text.DateFormat
import java.util.Calendar
import java.util.Date

class ToolError(message: String) : Exception(message)

class PhoneTools(private val activity: Activity) {
  private val ctx: Context = activity.applicationContext

  companion object {
    /** Every tool this host offers: what it says in `hello`. */
    val NAMES = listOf(
      "phone_set_timer", "phone_set_alarm", "phone_show_alarms",
      "phone_media_now_playing", "phone_media_control",
      "phone_notifications", "phone_reply",
      "phone_find_contact", "phone_call", "phone_send_sms",
      "phone_flashlight", "phone_do_not_disturb", "phone_volume",
      "phone_navigate", "phone_open_app", "open_on_phone",
    )

    private val NUMBER = Regex("^\\+?[0-9 ()\\-]{3,20}$")
  }

  /** The permission aliases (`DuckPlugin`'s) a call needs before it runs. */
  fun needs(tool: String, input: JSONObject): List<String> = when (tool) {
    "phone_find_contact" -> listOf("contacts")
    "phone_call" -> listOfNotNull("phone", "contacts".takeIf { !isNumber(input.optString("to")) })
    "phone_send_sms" -> listOfNotNull("sms", "contacts".takeIf { !isNumber(input.optString("to")) })
    else -> emptyList()
  }

  private fun isNumber(s: String) = NUMBER.matches(s.trim())

  fun run(tool: String, input: JSONObject): Any = when (tool) {
    "phone_set_timer" -> setTimer(input)
    "phone_set_alarm" -> setAlarm(input)
    "phone_show_alarms" -> showAlarms()
    "phone_media_now_playing" -> nowPlaying()
    "phone_media_control" -> mediaControl(input.getString("action"))
    "phone_notifications" -> notifications(input)
    "phone_reply" -> reply(input)
    "phone_find_contact" -> JSONObject().put("contacts", contacts(input.getString("name")))
    "phone_call" -> call(input.getString("to"))
    "phone_send_sms" -> sms(input.getString("to"), input.getString("text"))
    "phone_flashlight" -> flashlight(input.getBoolean("on"))
    "phone_do_not_disturb" -> dnd(input.getBoolean("on"))
    "phone_volume" -> volume(input)
    "phone_navigate" -> navigate(input)
    "phone_open_app" -> openApp(input.getString("app"))
    "open_on_phone" -> openUrl(input.getString("url"))
    else -> throw ToolError("this phone has no tool $tool")
  }

  private fun start(intent: Intent, what: String) {
    try {
      // The clock's handler is one instance: a second request while the first is
      // still open would reach it as a new intent, which it ignores.
      if (intent.action?.startsWith("android.intent.action.SET_") == true) intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK)
      activity.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (e: ActivityNotFoundException) {
      throw ToolError("no app on the phone can $what")
    }
  }

  private fun settingsPage(action: String, why: String): Nothing {
    start(Intent(action), "open that settings page")
    throw ToolError(why)
  }

  // ── the clock ──

  private fun setTimer(input: JSONObject): JSONObject {
    val seconds = input.getInt("seconds")
    if (seconds !in 1..86_400) throw ToolError("a timer is 1 second to 24 hours")
    val i = Intent(AlarmClock.ACTION_SET_TIMER)
      .putExtra(AlarmClock.EXTRA_LENGTH, seconds)
      .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
    input.optString("label").takeIf { it.isNotEmpty() }?.let { i.putExtra(AlarmClock.EXTRA_MESSAGE, it) }
    start(i, "set a timer")
    return JSONObject().put("timer", seconds).put("ends", time(System.currentTimeMillis() + seconds * 1000L))
  }

  private val DAYS = mapOf(
    "mon" to Calendar.MONDAY, "tue" to Calendar.TUESDAY, "wed" to Calendar.WEDNESDAY, "thu" to Calendar.THURSDAY,
    "fri" to Calendar.FRIDAY, "sat" to Calendar.SATURDAY, "sun" to Calendar.SUNDAY,
  )

  private fun setAlarm(input: JSONObject): JSONObject {
    val m = Regex("^([01]?\\d|2[0-3]):([0-5]\\d)$").find(input.getString("time")) ?: throw ToolError("the time is HH:MM")
    val i = Intent(AlarmClock.ACTION_SET_ALARM)
      .putExtra(AlarmClock.EXTRA_HOUR, m.groupValues[1].toInt())
      .putExtra(AlarmClock.EXTRA_MINUTES, m.groupValues[2].toInt())
      .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
    input.optString("label").takeIf { it.isNotEmpty() }?.let { i.putExtra(AlarmClock.EXTRA_MESSAGE, it) }
    input.optJSONArray("days")?.let { days ->
      i.putExtra(AlarmClock.EXTRA_DAYS, ArrayList((0 until days.length()).mapNotNull { DAYS[days.getString(it)] }))
    }
    start(i, "set an alarm")
    return JSONObject().put("alarm", input.getString("time"))
  }

  private fun showAlarms(): JSONObject {
    val next = ctx.getSystemService(AlarmManager::class.java).nextAlarmClock
    start(Intent(AlarmClock.ACTION_SHOW_ALARMS), "show the alarms")
    return JSONObject().put("next", next?.let { DateFormat.getDateTimeInstance(DateFormat.FULL, DateFormat.SHORT).format(Date(it.triggerTime)) } ?: "no alarm set")
  }

  private fun time(ms: Long) = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(ms))

  // ── media ──

  private fun sessions(): List<MediaController>? {
    if (!DuckNotifications.allowed(ctx)) return null
    return ctx.getSystemService(MediaSessionManager::class.java).getActiveSessions(DuckNotifications.component(ctx))
  }

  private fun stateName(s: Int?) = when (s) {
    PlaybackState.STATE_PLAYING -> "playing"
    PlaybackState.STATE_PAUSED -> "paused"
    PlaybackState.STATE_BUFFERING -> "buffering"
    PlaybackState.STATE_STOPPED -> "stopped"
    else -> "idle"
  }

  private fun describe(c: MediaController): JSONObject {
    val md = c.metadata
    return JSONObject()
      .put("app", appLabel(c.packageName))
      .put("title", md?.getString(android.media.MediaMetadata.METADATA_KEY_TITLE) ?: "")
      .put("artist", md?.getString(android.media.MediaMetadata.METADATA_KEY_ARTIST) ?: "")
      .put("state", stateName(c.playbackState?.state))
  }

  private fun nowPlaying(): Any {
    val list = sessions() ?: settingsPage(
      Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS,
      "Duck needs notification access to see what plays: I opened the page; turn on Duck there (a sideloaded app first needs \"Allow restricted settings\" in its App info), then ask again.",
    )
    if (list.isEmpty()) return "Nothing is playing on the phone."
    return JSONObject().put("sessions", JSONArray(list.map { describe(it) }))
  }

  private fun mediaControl(action: String): JSONObject {
    val list = sessions()
    val target = list?.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING } ?: list?.firstOrNull()
    if (target != null) {
      val t = target.transportControls
      val playing = target.playbackState?.state == PlaybackState.STATE_PLAYING
      when (action) {
        "play" -> t.play()
        "pause" -> t.pause()
        "toggle" -> if (playing) t.pause() else t.play()
        "next" -> t.skipToNext()
        "previous" -> t.skipToPrevious()
        else -> throw ToolError("no such action: $action")
      }
      return JSONObject().put("done", action).put("app", appLabel(target.packageName))
    }
    // Without notification access: a media key, which the playing app gets.
    val key = when (action) {
      "play" -> KeyEvent.KEYCODE_MEDIA_PLAY
      "pause" -> KeyEvent.KEYCODE_MEDIA_PAUSE
      "toggle" -> KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
      "next" -> KeyEvent.KEYCODE_MEDIA_NEXT
      "previous" -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
      else -> throw ToolError("no such action: $action")
    }
    val am = ctx.getSystemService(AudioManager::class.java)
    am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, key))
    am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, key))
    return JSONObject().put("done", action).put("by", "a media key")
  }

  // ── notifications ──

  private fun listener(): DuckNotifications {
    if (!DuckNotifications.allowed(ctx)) settingsPage(
      Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS,
      "Duck needs notification access: I opened the page; turn on Duck there (a sideloaded app first needs \"Allow restricted settings\" in its App info), then ask again.",
    )
    return DuckNotifications.live ?: throw ToolError("the notification listener isn't connected yet; try again in a moment")
  }

  private fun notifications(input: JSONObject): JSONObject {
    val l = listener()
    val all = input.optBoolean("all")
    val since = if (all) 0L else Store.get(ctx, "notificationsRead")?.toLongOrNull() ?: 0L
    val list = l.list(since, input.optInt("limit", 20))
    Store.put(ctx, "notificationsRead", System.currentTimeMillis().toString())
    val out = JSONObject().put("notifications", list)
    if (!all && list.length() == 0) out.put("note", "Nothing new since the last look.")
    return out
  }

  private fun reply(input: JSONObject): JSONObject {
    try {
      listener().reply(input.getString("key"), input.getString("text"))
    } catch (e: IllegalStateException) {
      throw ToolError(e.message ?: "the reply didn't go")
    }
    return JSONObject().put("replied", true)
  }

  // ── contacts, calls, texts ──

  private fun contacts(name: String): JSONArray {
    val out = JSONArray()
    val cols = arrayOf(
      ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
      ContactsContract.CommonDataKinds.Phone.NUMBER,
      ContactsContract.CommonDataKinds.Phone.TYPE,
      ContactsContract.CommonDataKinds.Phone.LABEL,
    )
    ctx.contentResolver.query(
      ContactsContract.CommonDataKinds.Phone.CONTENT_URI, cols,
      "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ?", arrayOf("%${name.trim()}%"),
      ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
    )?.use { c ->
      val seen = HashSet<String>()
      while (c.moveToNext() && out.length() < 10) {
        val number = c.getString(1) ?: continue
        if (!seen.add(c.getString(0) + number.filter { it.isDigit() })) continue
        val type = ContactsContract.CommonDataKinds.Phone.getTypeLabel(ctx.resources, c.getInt(2), c.getString(3)).toString()
        out.put(JSONObject().put("name", c.getString(0)).put("number", number).put("type", type))
      }
    }
    return out
  }

  /** `to` as a number: itself, or a contact's only number; else why not. */
  private fun numberFor(to: String): String {
    if (isNumber(to)) return to.trim()
    val found = contacts(to)
    if (found.length() == 0) throw ToolError("no contact matches \"$to\"")
    if (found.length() > 1) {
      val choices = (0 until found.length()).joinToString("; ") {
        val c = found.getJSONObject(it)
        "${c.getString("name")} (${c.getString("type")}) ${c.getString("number")}"
      }
      throw ToolError("more than one number matches \"$to\": $choices. Ask which, and call again with the number.")
    }
    return found.getJSONObject(0).getString("number")
  }

  private fun call(to: String): JSONObject {
    val number = numberFor(to)
    start(Intent(Intent.ACTION_CALL, Uri.fromParts("tel", number, null)), "make calls")
    return JSONObject().put("calling", number)
  }

  private fun sms(to: String, text: String): JSONObject {
    val number = numberFor(to)
    val sm = if (Build.VERSION.SDK_INT >= 31) ctx.getSystemService(SmsManager::class.java) else @Suppress("DEPRECATION") SmsManager.getDefault()
    sm.sendMultipartTextMessage(number, null, sm.divideMessage(text), null, null)
    return JSONObject().put("sent", number)
  }

  // ── small things ──

  private fun flashlight(on: Boolean): JSONObject {
    val cm = ctx.getSystemService(CameraManager::class.java)
    val id = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true }
      ?: throw ToolError("this phone has no flashlight")
    cm.setTorchMode(id, on)
    return JSONObject().put("flashlight", if (on) "on" else "off")
  }

  private fun dnd(on: Boolean): JSONObject {
    val nm = ctx.getSystemService(NotificationManager::class.java)
    if (!nm.isNotificationPolicyAccessGranted) settingsPage(
      Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS,
      "Duck needs Do Not Disturb access: I opened the page; allow Duck there, then ask again.",
    )
    nm.setInterruptionFilter(if (on) NotificationManager.INTERRUPTION_FILTER_PRIORITY else NotificationManager.INTERRUPTION_FILTER_ALL)
    return JSONObject().put("doNotDisturb", if (on) "on" else "off")
  }

  private fun volume(input: JSONObject): JSONObject {
    val am = ctx.getSystemService(AudioManager::class.java)
    val stream = when (input.optString("stream", "media")) {
      "ring" -> AudioManager.STREAM_RING
      "alarm" -> AudioManager.STREAM_ALARM
      else -> AudioManager.STREAM_MUSIC
    }
    try {
      if (input.has("level")) {
        val max = am.getStreamMaxVolume(stream)
        am.setStreamVolume(stream, Math.round(input.getInt("level").coerceIn(0, 100) * max / 100f), 0)
      } else {
        val dir = when (input.optString("change")) {
          "up" -> AudioManager.ADJUST_RAISE
          "down" -> AudioManager.ADJUST_LOWER
          "mute" -> AudioManager.ADJUST_MUTE
          "unmute" -> AudioManager.ADJUST_UNMUTE
          else -> throw ToolError("say a level, or up, down, mute or unmute")
        }
        am.adjustStreamVolume(stream, dir, 0)
      }
    } catch (e: SecurityException) {
      throw ToolError("the phone won't change that volume now (Do Not Disturb holds it)")
    }
    val pct = Math.round(am.getStreamVolume(stream) * 100f / am.getStreamMaxVolume(stream))
    return JSONObject().put("volume", pct)
  }

  private fun navigate(input: JSONObject): JSONObject {
    val mode = input.optString("mode", "driving")
    val uri = Uri.parse("https://www.google.com/maps/dir/?api=1&destination=${Uri.encode(input.getString("to"))}&travelmode=$mode&dir_action=navigate")
    start(Intent(Intent.ACTION_VIEW, uri), "show directions")
    return JSONObject().put("directionsTo", input.getString("to"))
  }

  private fun appLabel(pkg: String): String = try {
    ctx.packageManager.getApplicationLabel(ctx.packageManager.getApplicationInfo(pkg, 0)).toString()
  } catch (e: Exception) {
    pkg
  }

  private fun openApp(name: String): JSONObject {
    val pm = ctx.packageManager
    val apps = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
      .map { it.loadLabel(pm).toString() to it.activityInfo.packageName }
      .distinctBy { it.second }
    val q = name.trim().lowercase()
    val hits = apps.filter { it.first.lowercase() == q }.ifEmpty {
      apps.filter { it.first.lowercase().startsWith(q) }.ifEmpty { apps.filter { it.first.lowercase().contains(q) } }
    }
    when {
      hits.isEmpty() -> throw ToolError("no app called \"$name\" on the phone")
      hits.size > 1 -> throw ToolError("more than one app matches \"$name\": ${hits.take(6).joinToString { it.first }}")
    }
    val launch = pm.getLaunchIntentForPackage(hits[0].second) ?: throw ToolError("${hits[0].first} can't be opened")
    start(launch, "open ${hits[0].first}")
    return JSONObject().put("opened", hits[0].first)
  }

  private fun openUrl(url: String): JSONObject {
    val uri = Uri.parse(url)
    if (uri.scheme != "http" && uri.scheme != "https") throw ToolError("only http and https links open on the phone")
    start(Intent(Intent.ACTION_VIEW, uri), "open that link")
    return JSONObject().put("opened", url)
  }
}

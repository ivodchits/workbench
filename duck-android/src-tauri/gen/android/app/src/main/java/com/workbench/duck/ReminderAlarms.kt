// Duck's reminders on the phone (H5): the desktop sends the open reminders'
// coming times (`phone.reminders`, two weeks of a repeat's), and the app arms
// each as an exact alarm, so it rings in airplane mode or with the desktop off.
// Its notification has Done and Snooze 10 min: Snooze arms a new alarm here at
// once; both are kept until the page next reaches the desktop, which makes the
// same change its own buttons would (`reminder.action`). A new list replaces the
// armed one; a reboot arms it again.

package com.workbench.duck

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

object ReminderAlarms {
  const val CHANNEL = "reminders"
  const val SNOOZE_MS = 10 * 60_000L
  private const val RING = "com.workbench.duck.REMINDER"
  private const val DONE = "com.workbench.duck.REMINDER_DONE"
  private const val SNOOZE = "com.workbench.duck.REMINDER_SNOOZE"

  private fun ringIntent(ctx: Context, id: String, at: Long, title: String, body: String): PendingIntent {
    val i = Intent(ctx, ReminderReceiver::class.java)
      .setAction(RING)
      .setData(Uri.parse("duck://reminder/${Uri.encode(id)}/$at"))
      .putExtra("id", id)
      .putExtra("title", title)
      .putExtra("body", body)
    return PendingIntent.getBroadcast(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun canExact(am: AlarmManager) = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()

  private fun set(ctx: Context, at: Long, pi: PendingIntent) {
    val am = ctx.getSystemService(AlarmManager::class.java)
    if (canExact(am)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
    else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
  }

  /** Arm `alarms` (`[{id, title, body, at: [ms]}]`) in place of what was armed. */
  @Synchronized
  fun arm(ctx: Context, alarms: JSONArray) {
    disarm(ctx)
    val now = System.currentTimeMillis()
    val kept = JSONArray()
    for (k in 0 until alarms.length()) {
      val a = alarms.getJSONObject(k)
      val times = a.getJSONArray("at")
      val future = JSONArray()
      for (t in 0 until times.length()) {
        val at = times.getLong(t)
        if (at <= now) continue
        set(ctx, at, ringIntent(ctx, a.getString("id"), at, a.getString("title"), a.optString("body")))
        future.put(at)
      }
      if (future.length() > 0) kept.put(JSONObject(a.toString()).put("at", future))
    }
    Store.put(ctx, "armed", kept.toString())
  }

  /** Arm again what was armed (after a reboot). */
  fun rearm(ctx: Context) = arm(ctx, JSONArray(Store.get(ctx, "armed") ?: "[]"))

  private fun disarm(ctx: Context) {
    val am = ctx.getSystemService(AlarmManager::class.java)
    val armed = JSONArray(Store.get(ctx, "armed") ?: "[]")
    for (k in 0 until armed.length()) {
      val a = armed.getJSONObject(k)
      val times = a.getJSONArray("at")
      for (t in 0 until times.length())
        am.cancel(ringIntent(ctx, a.getString("id"), times.getLong(t), a.getString("title"), a.optString("body")))
    }
  }

  fun channel(ctx: Context) {
    if (Build.VERSION.SDK_INT >= 26)
      ctx.getSystemService(NotificationManager::class.java)
        .createNotificationChannel(NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH))
  }

  private fun notifyId(id: String) = id.hashCode()

  fun show(ctx: Context, id: String, title: String, body: String) {
    channel(ctx)
    fun action(label: String, what: String, code: Int) = Notification.Action.Builder(
      null, label,
      PendingIntent.getBroadcast(
        ctx, code,
        Intent(ctx, ReminderReceiver::class.java).setAction(what).setData(Uri.parse("duck://act/${Uri.encode(id)}"))
          .putExtra("id", id).putExtra("title", title).putExtra("body", body),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      ),
    ).build()
    val open = PendingIntent.getActivity(
      ctx, 5, Intent(ctx, MainActivity::class.java).putExtra(MainActivity.LAUNCH, "open")
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val n = Notification.Builder(ctx, CHANNEL)
      .setSmallIcon(R.drawable.ic_duck)
      .setContentTitle("⏰ $title")
      .setContentText(body.ifEmpty { "Reminder" })
      .setCategory(Notification.CATEGORY_REMINDER)
      .setContentIntent(open)
      .setAutoCancel(true)
      .addAction(action("Done", DONE, 6))
      .addAction(action("Snooze 10 min", SNOOZE, 7))
      .build()
    ctx.getSystemService(NotificationManager::class.java).notify("reminder", notifyId(id), n)
  }

  fun handle(ctx: Context, intent: Intent) {
    val id = intent.getStringExtra("id") ?: return
    val title = intent.getStringExtra("title") ?: ""
    val body = intent.getStringExtra("body") ?: ""
    when (intent.action) {
      RING -> show(ctx, id, title, body)
      DONE, SNOOZE -> {
        ctx.getSystemService(NotificationManager::class.java).cancel("reminder", notifyId(id))
        val action = if (intent.action == DONE) "done" else "snooze"
        if (action == "snooze") {
          val at = System.currentTimeMillis() + SNOOZE_MS
          set(ctx, at, ringIntent(ctx, id, at, title, body))
        }
        Store.queueAction(ctx, id, action)
        DuckPlugin.instance?.reminderActed()
      }
    }
  }
}

/** An alarm ringing, or Done / Snooze tapped: only this app sends these. */
class ReminderReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) = ReminderAlarms.handle(ctx, intent)
}

/** A reboot or an update cleared the alarms: arm them again. */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED)
      ReminderAlarms.rearm(ctx)
  }
}

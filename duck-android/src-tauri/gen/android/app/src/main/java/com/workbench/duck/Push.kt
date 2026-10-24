// The desktop's pushes in the app, through UnifiedPush. The page's WebView has no
// Push API, so a distributor app on the phone (ntfy, say) holds the connection
// and hands this app a Web Push endpoint with its keys. The page sends that to
// the desktop like a browser's subscription (`/api/push/subscribe`), so the
// desktop pushes here exactly as it does to a browser; the connector decrypts
// each message and this shows it as a notification.
//
// - `push_status` / `push_register` / `push_unregister` are the page's
//   (`DuckPlugin`); a new endpoint comes to the page as a `pushEndpoint` event
//   and is kept for the next time the page asks.
// - A tap opens the app on the card or Duck's thread the push names (a `push`
//   launch). A reminder whose alarm is armed here is left to the alarm, which
//   rings with its own Done and Snooze.

package com.workbench.duck

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

object Pushes {
  const val CHANNEL = "pushes"

  fun channel(ctx: Context) {
    ctx.getSystemService(NotificationManager::class.java)
      .createNotificationChannel(NotificationChannel(CHANNEL, "Workbench", NotificationManager.IMPORTANCE_HIGH))
  }

  /** What the page needs to know: the distributor, the endpoint, the last failure. */
  fun status(ctx: Context): JSONObject {
    val distributors = UnifiedPush.getDistributors(ctx)
    return JSONObject()
      .put("distributors", JSONArray(distributors.map { label(ctx, it) }))
      .put("distributor", UnifiedPush.getAckDistributor(ctx)?.let { label(ctx, it) } ?: JSONObject.NULL)
      .put("endpoint", Store.get(ctx, "pushEndpoint")?.let { JSONObject(it) } ?: JSONObject.NULL)
      .put("vapid", Store.get(ctx, "pushVapid") ?: JSONObject.NULL)
      .put("error", Store.get(ctx, "pushError") ?: JSONObject.NULL)
  }

  private fun label(ctx: Context, pkg: String): String = try {
    ctx.packageManager.getApplicationLabel(ctx.packageManager.getApplicationInfo(pkg, 0)).toString()
  } catch (e: Exception) {
    pkg
  }

  /** Register with the phone's distributor (asking which, when there are several)
   *  for pushes signed with `vapid`; `done(null)` once asked, else why not. The
   *  endpoint comes later, to `DuckPushService.onNewEndpoint`. */
  fun register(activity: Activity, vapid: String, done: (String?) -> Unit) {
    val ctx = activity.applicationContext
    UnifiedPush.tryUseCurrentOrDefaultDistributor(activity) { ok ->
      if (!ok) return@tryUseCurrentOrDefaultDistributor done(
        if (UnifiedPush.getDistributors(ctx).isEmpty()) "no UnifiedPush distributor: install ntfy first" else "no distributor chosen",
      )
      try {
        // A new key (the desktop's database reset) means a new endpoint.
        if (Store.get(ctx, "pushVapid") != vapid) Store.put(ctx, "pushEndpoint", null)
        Store.put(ctx, "pushVapid", vapid)
        Store.put(ctx, "pushError", null)
        UnifiedPush.register(ctx, messageForDistributor = "Workbench", vapid = vapid)
        done(null)
      } catch (e: Exception) {
        done(e.message ?: e.toString())
      }
    }
  }

  fun unregister(ctx: Context) {
    UnifiedPush.unregister(ctx)
    Store.put(ctx, "pushEndpoint", null)
  }

  /** A reminder the alarms here already ring. */
  private fun armed(ctx: Context, id: String): Boolean {
    val armed = JSONArray(Store.get(ctx, "armed") ?: "[]")
    return (0 until armed.length()).any { armed.getJSONObject(it).optString("id") == id }
  }

  /** Show one of the desktop's pushes: `{title, body, tag, instanceId?, threadId?, reminder?}`. */
  fun show(ctx: Context, data: JSONObject) {
    val tag = data.optString("tag").ifEmpty { "workbench" }
    if (tag.startsWith("reminder-") && armed(ctx, tag.removePrefix("reminder-"))) return
    channel(ctx)
    val launch = Intent(ctx, MainActivity::class.java)
      .putExtra(MainActivity.LAUNCH, "push")
      .putExtra("instanceId", data.optString("instanceId").ifEmpty { null })
      .putExtra("threadId", data.optString("threadId").ifEmpty { null })
      // A distinct data URI per tag keeps each notification's extras its own.
      .setData(Uri.parse("duck://push/${Uri.encode(tag)}"))
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val open = PendingIntent.getActivity(ctx, 8, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val body = data.optString("body")
    val n = Notification.Builder(ctx, CHANNEL)
      .setSmallIcon(R.drawable.ic_duck)
      .setContentTitle(data.optString("title").ifEmpty { "Workbench" })
      .setContentText(body)
      .setStyle(Notification.BigTextStyle().bigText(body))
      .setCategory(Notification.CATEGORY_MESSAGE)
      .setContentIntent(open)
      .setAutoCancel(true)
      .build()
    ctx.getSystemService(NotificationManager::class.java).notify(tag, 0, n)
  }
}

/** The distributor's messages for this app. */
class DuckPushService : PushService() {
  override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
    val keys = endpoint.pubKeySet
    if (keys == null) {
      Store.put(this, "pushError", "the distributor gave no encryption keys")
      return
    }
    val sub = JSONObject().put("endpoint", endpoint.url).put("p256dh", keys.pubKey).put("auth", keys.auth)
    Store.put(this, "pushEndpoint", sub.toString())
    Store.put(this, "pushError", null)
    DuckPlugin.instance?.pushEndpoint()
  }

  override fun onMessage(message: PushMessage, instance: String) {
    if (!message.decrypted) return
    val data = try {
      JSONObject(String(message.content, Charsets.UTF_8))
    } catch (e: Exception) {
      JSONObject().put("body", String(message.content, Charsets.UTF_8))
    }
    Pushes.show(this, data)
  }

  override fun onRegistrationFailed(reason: FailedReason, instance: String) {
    Store.put(this, "pushError", "registration failed: ${reason.name.lowercase().replace('_', ' ')}")
    DuckPlugin.instance?.pushEndpoint()
  }

  override fun onUnregistered(instance: String) {
    Store.put(this, "pushEndpoint", null)
    DuckPlugin.instance?.pushEndpoint()
  }
}

// The phone's notifications (H5): Duck reads them ("what did I miss?") and
// replies through a notification's own reply action. Also what lets the app see
// the media sessions (`MediaSessionManager.getActiveSessions` takes a listener's
// name). Access is granted in Settings → Notification access; a sideloaded app
// first needs "Allow restricted settings" in its App info.

package com.workbench.duck

import android.app.Notification
import android.app.RemoteInput
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject

class DuckNotifications : NotificationListenerService() {
  companion object {
    @Volatile var live: DuckNotifications? = null
      private set

    fun component(ctx: Context) = ComponentName(ctx, DuckNotifications::class.java)

    fun allowed(ctx: Context): Boolean =
      NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName)
  }

  override fun onListenerConnected() {
    live = this
  }

  override fun onListenerDisconnected() {
    if (live === this) live = null
  }

  private fun appName(pkg: String): String = try {
    packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
  } catch (e: Exception) {
    pkg
  }

  private fun replyAction(n: Notification): Notification.Action? =
    n.actions?.firstOrNull { a -> a.remoteInputs?.any { it.allowFreeFormInput } == true }

  /** What a notification says: its title and text, a chat's latest messages. */
  private fun textOf(n: Notification): Pair<String?, String?> {
    val x = n.extras
    val title = (x.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE) ?: x.getCharSequence(Notification.EXTRA_TITLE))?.toString()
    val messages = x.getParcelableArray(Notification.EXTRA_MESSAGES)
    if (!messages.isNullOrEmpty()) {
      val lines = messages.takeLast(5).mapNotNull { m ->
        val b = m as? Bundle ?: return@mapNotNull null
        val who = b.getCharSequence("sender")?.toString()
        val text = b.getCharSequence("text")?.toString() ?: return@mapNotNull null
        if (who.isNullOrEmpty()) text else "$who: $text"
      }
      if (lines.isNotEmpty()) return title to lines.joinToString("\n")
    }
    val text = (x.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: x.getCharSequence(Notification.EXTRA_TEXT))?.toString()
    return title to text
  }

  private fun worth(s: StatusBarNotification): Boolean =
    s.packageName != packageName && !s.isOngoing && s.notification.flags and Notification.FLAG_GROUP_SUMMARY == 0

  /** The notifications showing, newest first: since `since` (ms), or all. */
  fun list(since: Long, limit: Int): JSONArray {
    val out = JSONArray()
    activeNotifications.orEmpty()
      .filter { worth(it) && it.postTime > since }
      .sortedByDescending { it.postTime }
      .map { it to textOf(it.notification) }
      // A custom view (the Clock's running timer) says nothing readable.
      .filter { (_, t) -> !t.first.isNullOrBlank() || !t.second.isNullOrBlank() }
      .take(limit)
      .forEach { (s, t) ->
        val (title, text) = t
        out.put(
          JSONObject()
            .put("key", s.key)
            .put("app", appName(s.packageName))
            .put("title", title ?: "")
            .put("text", (text ?: "").take(1500))
            .put("when", s.postTime)
            .put("canReply", replyAction(s.notification) != null),
        )
      }
    return out
  }

  /** Reply through the notification's own action; throws why it can't. */
  fun reply(key: String, text: String) {
    val s = activeNotifications.orEmpty().firstOrNull { it.key == key }
      ?: throw IllegalStateException("that notification is gone")
    val action = replyAction(s.notification) ?: throw IllegalStateException("${appName(s.packageName)}'s notification has no reply")
    val inputs = action.remoteInputs.filter { it.allowFreeFormInput }.toTypedArray()
    val intent = Intent()
    RemoteInput.addResultsToIntent(inputs, intent, Bundle().apply { inputs.forEach { putCharSequence(it.resultKey, text) } })
    action.actionIntent.send(this, 0, intent)
  }
}

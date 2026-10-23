// Conversation mode with the screen off (R4): a foreground service of the
// microphone and media-playback types, so the mic and Duck's voice keep going
// with the phone in a pocket. It's started only from something you did (the
// tile, the widget, the assistant gesture, the page's talk button), as Android
// 14+ requires. Its notification has Stop; a partial wake lock keeps the CPU up
// for the socket while it runs.

package com.workbench.duck

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.service.quicksettings.TileService
import android.content.ComponentName

class ConversationService : Service() {
  companion object {
    const val CHANNEL = "conversation"
    const val STOP = "com.workbench.duck.STOP_TALK"
    private const val ID = 7

    @Volatile var running = false
      private set

    fun start(ctx: Context) {
      val i = Intent(ctx, ConversationService::class.java)
      if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
    }

    fun stop(ctx: Context) {
      ctx.stopService(Intent(ctx, ConversationService::class.java))
    }
  }

  private var wake: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == STOP) {
      // Stop from the notification: the page ends conversation mode, which stops this.
      DuckPlugin.instance?.talkStopped("stopped from the notification") ?: stopSelf()
      return START_NOT_STICKY
    }
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26)
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "Conversation with Duck", NotificationManager.IMPORTANCE_LOW))
    val open = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE,
    )
    val stop = PendingIntent.getService(
      this, 1, Intent(this, ConversationService::class.java).setAction(STOP),
      PendingIntent.FLAG_IMMUTABLE,
    )
    val n = Notification.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_duck)
      .setContentTitle("Talking with Duck")
      .setContentText("Duck is listening. Say \"that's all for now\" to stop.")
      .setOngoing(true)
      .setContentIntent(open)
      .addAction(Notification.Action.Builder(null, "Stop", stop).build())
      .build()
    if (Build.VERSION.SDK_INT >= 30)
      startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    else startForeground(ID, n)
    if (wake == null)
      wake = getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "duck:conversation")
        .apply { acquire(4 * 60 * 60 * 1000L) }
    running = true
    TileService.requestListeningState(this, ComponentName(this, DuckTile::class.java))
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    wake?.let { if (it.isHeld) it.release() }
    wake = null
    TileService.requestListeningState(this, ComponentName(this, DuckTile::class.java))
    super.onDestroy()
  }
}

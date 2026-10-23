// Duck's ways in besides the app icon (R4): the Quick Settings tile, which turns
// conversation mode on and off, and the home-screen widget, a talk button and a
// status line. The widget shows what the page last told it (`widget_status`):
// the app can't ask the desktop by itself, so the line says how old it is.

package com.workbench.duck

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.text.format.DateUtils
import android.widget.RemoteViews

class DuckTile : TileService() {
  override fun onStartListening() {
    qsTile?.apply {
      state = if (ConversationService.running) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
      if (Build.VERSION.SDK_INT >= 29) subtitle = if (ConversationService.running) "Listening" else "Talk"
      updateTile()
    }
  }

  override fun onClick() {
    if (ConversationService.running) {
      DuckPlugin.instance?.talkStopped("stopped from the tile") ?: ConversationService.stop(this)
      return
    }
    // Android 14+ only opens an activity from a tile through a PendingIntent.
    val intent = Intent(this, MainActivity::class.java)
      .putExtra(MainActivity.LAUNCH, "talk")
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (Build.VERSION.SDK_INT >= 34)
      startActivityAndCollapse(PendingIntent.getActivity(this, 2, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
    else @Suppress("DEPRECATION") startActivityAndCollapse(intent)
  }
}

class DuckWidget : AppWidgetProvider() {
  companion object {
    /** Draw every Duck widget with the latest status. */
    fun refresh(ctx: Context) {
      val mgr = AppWidgetManager.getInstance(ctx)
      val ids = mgr.getAppWidgetIds(ComponentName(ctx, DuckWidget::class.java))
      if (ids.isNotEmpty()) mgr.updateAppWidget(ids, views(ctx))
    }

    private fun open(ctx: Context, code: Int, launch: String) = PendingIntent.getActivity(
      ctx, code,
      Intent(ctx, MainActivity::class.java)
        .putExtra(MainActivity.LAUNCH, launch)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun views(ctx: Context): RemoteViews {
      val text = Store.get(ctx, "widgetText") ?: "Tap to open Duck"
      val at = Store.get(ctx, "widgetAt")?.toLongOrNull()
      val age = if (at == null) "" else " · " + DateUtils.getRelativeTimeSpanString(at, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS)
      return RemoteViews(ctx.packageName, R.layout.duck_widget).apply {
        setTextViewText(R.id.widget_status, text + age)
        setOnClickPendingIntent(R.id.widget_status, open(ctx, 3, "open"))
        setOnClickPendingIntent(R.id.widget_talk, open(ctx, 4, "listen"))
      }
    }
  }

  override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
    mgr.updateAppWidget(ids, views(ctx))
  }
}

package com.workbench.duck

import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import org.json.JSONObject

// The app's one activity (R4). Opened by the launcher, the assistant gesture
// (`DuckSession`, over the lock screen), the tile, the widget, or a reminder;
// what opened it goes to the page as a launch (`Launches`).
class MainActivity : TauriActivity() {
  companion object {
    /** The intent extra naming why it opened: assist, talk, listen, open. */
    const val LAUNCH = "duck.launch"
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    if (savedInstanceState == null) took(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    took(intent)
  }

  private fun took(intent: Intent) {
    val kind = intent.getStringExtra(LAUNCH) ?: if (intent.action == Intent.ACTION_ASSIST) "assist" else return
    intent.removeExtra(LAUNCH)
    // The assistant gesture works over the lock screen; the phone's tools wait
    // for an unlock there unless that's turned off (`DuckPlugin.run`).
    if (kind == "assist" && Build.VERSION.SDK_INT >= 27) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    }
    Launches.post(JSONObject().put("kind", kind))
  }

  override fun onPause() {
    super.onPause()
    // Conversation mode goes on with the screen off: keep the page running.
    if (ConversationService.running) DuckPlugin.instance?.webView?.onResume()
  }
}

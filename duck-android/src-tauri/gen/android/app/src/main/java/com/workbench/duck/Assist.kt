// The assistant role (R4, H5): Duck as the phone's default digital assistant.
// Long-pressing power (or the assistant gesture) starts a session here, which
// opens the app listening, over the lock screen too. What's on screen comes with
// it (the text of the app in front, when "use text from screen" is on), for the
// first message ("what's this?").
//
// Android only lists an app as an assistant with a voice interaction service, a
// session service and a recognition service. Duck hears through its own mic, so
// the recognition service only hands other apps' requests on to the phone's own
// recognizer (`Recognizers`): being the assistant mustn't break voice input
// elsewhere.

package com.workbench.duck

import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.SpeechRecognizer
import org.json.JSONObject

class DuckAssistService : VoiceInteractionService()

class DuckSessionService : VoiceInteractionSessionService() {
  override fun onNewSession(args: Bundle?): VoiceInteractionSession = DuckSession(this)
}

class DuckRecognitionService : RecognitionService() {
  private var inner: SpeechRecognizer? = null

  override fun onStartListening(intent: Intent?, listener: Callback?) {
    inner?.destroy()
    val sr = Recognizers.create(this)
    if (sr == null || listener == null || intent == null) {
      listener?.error(SpeechRecognizer.ERROR_CLIENT)
      return
    }
    inner = sr
    sr.setRecognitionListener(object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle?) = listener.readyForSpeech(params ?: Bundle())
      override fun onBeginningOfSpeech() = listener.beginningOfSpeech()
      override fun onRmsChanged(rmsdB: Float) = listener.rmsChanged(rmsdB)
      override fun onBufferReceived(buffer: ByteArray?) = listener.bufferReceived(buffer ?: ByteArray(0))
      override fun onEndOfSpeech() = listener.endOfSpeech()
      override fun onError(error: Int) = listener.error(error)
      override fun onResults(results: Bundle?) = listener.results(results ?: Bundle())
      override fun onPartialResults(partialResults: Bundle?) = listener.partialResults(partialResults ?: Bundle())
      override fun onEvent(eventType: Int, params: Bundle?) {}
    })
    sr.startListening(intent)
  }

  override fun onCancel(listener: Callback?) {
    inner?.cancel()
  }

  override fun onStopListening(listener: Callback?) {
    inner?.stopListening()
  }

  override fun onDestroy() {
    inner?.destroy()
    inner = null
    super.onDestroy()
  }
}

/** Why the app was opened, for the page to act on (`launch`). */
object Launches {
  /** Launches the page hasn't taken yet (`{kind, …}`), oldest first. */
  private val pending = mutableListOf<JSONObject>()

  @Synchronized
  fun take(): List<JSONObject> = pending.toList().also { pending.clear() }

  /** A launch to act on: to the page when it listens, else kept until it asks. */
  fun post(launch: JSONObject) {
    val plugin = DuckPlugin.instance
    if (plugin != null && plugin.hasListener("launch")) plugin.launched(launch)
    else synchronized(this) { pending.add(launch) }
  }

  /** The text of a screen: each view's text and content description, in order. */
  fun screenText(s: AssistStructure, max: Int = 4000): String {
    val out = StringBuilder()
    fun walk(n: AssistStructure.ViewNode) {
      if (out.length >= max) return
      val t = n.text?.toString()?.trim().orEmpty().ifEmpty { n.contentDescription?.toString()?.trim().orEmpty() }
      if (t.isNotEmpty()) out.append(t).append('\n')
      for (k in 0 until n.childCount) walk(n.getChildAt(k))
    }
    for (w in 0 until s.windowNodeCount) walk(s.getWindowNodeAt(w).rootViewNode)
    return out.toString().take(max).trim()
  }
}

class DuckSession(ctx: Context) : VoiceInteractionSession(ctx) {
  override fun onShow(args: Bundle?, showFlags: Int) {
    super.onShow(args, showFlags)
    // The app's own task, not `startAssistantActivity`'s: that makes a second
    // activity in an assistant task, and the app has one webview.
    context.startActivity(
      Intent(context, MainActivity::class.java)
        .putExtra(MainActivity.LAUNCH, "assist")
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
    )
  }

  /** The screen comes after the activity opened: a `screen` launch of its own,
   *  which the page keeps for the first message. */
  override fun onHandleAssist(state: AssistState) {
    val s = state.assistStructure
    if (s != null) {
      val text = Launches.screenText(s)
      val app = s.activityComponent?.packageName
      if (text.isNotEmpty() && app != context.packageName)
        Launches.post(JSONObject().put("kind", "screen").put("app", app ?: "").put("text", text))
    }
    finish()
  }
}

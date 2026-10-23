// The phone's mic, native (R4): 16 kHz mono int16 from the voice-communication
// source, so the phone's own echo cancellation and noise suppression run on it
// (and `AcousticEchoCanceler` where the source doesn't). Frames of 512 samples
// (32 ms, the desktop VAD's) go to the page as base64; the page frames them as
// the PWA does (`converse.ts`). It works with the screen off while the
// conversation service runs, and over a plain-http page, where a browser mic
// wouldn't.

package com.workbench.duck

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.util.Base64

class Mic(private val onFrame: (String) -> Unit, private val onError: (String) -> Unit) {
  companion object {
    const val RATE = 16_000
    const val FRAME = 512
  }

  @Volatile private var running = false
  private var thread: Thread? = null

  @SuppressLint("MissingPermission") // checked by the plugin before it starts one
  fun start() {
    val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val rec = AudioRecord(
      MediaRecorder.AudioSource.VOICE_COMMUNICATION,
      RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      maxOf(min, FRAME * 2 * 8),
    )
    if (rec.state != AudioRecord.STATE_INITIALIZED) {
      rec.release()
      throw IllegalStateException("the mic didn't open")
    }
    if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(rec.audioSessionId)?.enabled = true
    if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(rec.audioSessionId)?.enabled = true
    running = true
    rec.startRecording()
    thread = Thread {
      val samples = ShortArray(FRAME)
      val bytes = ByteArray(FRAME * 2)
      try {
        while (running) {
          var got = 0
          while (got < FRAME && running) {
            val n = rec.read(samples, got, FRAME - got)
            if (n < 0) throw IllegalStateException("the mic stopped ($n)")
            got += n
          }
          if (!running) break
          for (k in 0 until FRAME) {
            bytes[2 * k] = (samples[k].toInt() and 0xff).toByte()
            bytes[2 * k + 1] = (samples[k].toInt() shr 8 and 0xff).toByte()
          }
          onFrame(Base64.encodeToString(bytes, Base64.NO_WRAP))
        }
      } catch (e: Exception) {
        if (running) onError(e.message ?: e.toString())
      } finally {
        rec.stop()
        rec.release()
      }
    }.apply {
      name = "duck-mic"
      start()
    }
  }

  fun stop() {
    running = false
    thread = null
  }

  val isRunning: Boolean get() = running
}

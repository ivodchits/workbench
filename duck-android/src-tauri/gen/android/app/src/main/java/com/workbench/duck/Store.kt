// What the app keeps (R4, H5): the desktop's address, the device token (sealed with
// a Keystore AES key, so a copy of the app's files doesn't carry it), the app's
// own settings, the widget's line, the armed reminders, and Done / Snooze taps
// that haven't reached the desktop yet.

package com.workbench.duck

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object Store {
  private const val PREFS = "duck"
  private const val SEAL_ALIAS = "duck-seal"

  private fun prefs(ctx: Context): SharedPreferences = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun get(ctx: Context, key: String): String? = prefs(ctx).getString(key, null)

  fun put(ctx: Context, key: String, value: String?) {
    prefs(ctx).edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
  }

  // ── the device token, sealed ──

  private fun sealKey(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getEntry(SEAL_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      KeyGenParameterSpec.Builder(SEAL_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .build()
    )
    return gen.generateKey()
  }

  fun token(ctx: Context): String? {
    val sealed = get(ctx, "token") ?: return null
    return try {
      val bytes = Base64.decode(sealed, Base64.NO_WRAP)
      val c = Cipher.getInstance("AES/GCM/NoPadding")
      c.init(Cipher.DECRYPT_MODE, sealKey(), GCMParameterSpec(128, bytes, 0, 12))
      String(c.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8)
    } catch (e: Exception) {
      null
    }
  }

  fun setToken(ctx: Context, token: String?) {
    if (token == null) return put(ctx, "token", null)
    val c = Cipher.getInstance("AES/GCM/NoPadding")
    c.init(Cipher.ENCRYPT_MODE, sealKey())
    val out = c.iv + c.doFinal(token.toByteArray(Charsets.UTF_8))
    put(ctx, "token", Base64.encodeToString(out, Base64.NO_WRAP))
  }

  // ── settings ──

  /** The app's own settings: `requireUnlock` (phone tools wait for an unlock over
   *  the lock screen). */
  fun settings(ctx: Context): JSONObject = JSONObject(get(ctx, "settings") ?: "{\"requireUnlock\":true}")

  fun setSettings(ctx: Context, s: JSONObject) = put(ctx, "settings", s.toString())

  // ── Done / Snooze not yet told to the desktop ──

  @Synchronized
  fun queueAction(ctx: Context, id: String, action: String) {
    val list = JSONArray(get(ctx, "reminderActions") ?: "[]")
    list.put(JSONObject().put("id", id).put("action", action).put("at", System.currentTimeMillis()))
    put(ctx, "reminderActions", list.toString())
  }

  @Synchronized
  fun takeActions(ctx: Context): JSONArray {
    val list = JSONArray(get(ctx, "reminderActions") ?: "[]")
    put(ctx, "reminderActions", null)
    return list
  }
}

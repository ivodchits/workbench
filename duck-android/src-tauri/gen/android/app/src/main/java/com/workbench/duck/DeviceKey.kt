// The device key (R4): the PWA's P-256 key (`deviceKey.ts`), made in the Android
// Keystore instead, in StrongBox where the phone has it, never exportable. The
// page signs the desktop's challenge with it the same way: the public half as the
// uncompressed point, a signature as WebCrypto's 64-byte r‖s, both base64url.

package com.workbench.duck

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

object DeviceKey {
  private const val ALIAS = "duck-device"

  private fun keystore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  fun b64url(bytes: ByteArray): String =
    Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

  /** A new key in place of any before; its public half. */
  fun create(ctx: Context): String {
    drop()
    val strongBox = Build.VERSION.SDK_INT >= 28 &&
      ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
    val pair = try {
      generate(strongBox)
    } catch (e: StrongBoxUnavailableException) {
      generate(false)
    }
    return b64url(rawPoint(pair.public as ECPublicKey))
  }

  private fun generate(strongBox: Boolean) =
    KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
      initialize(
        KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
          .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
          .setDigests(KeyProperties.DIGEST_SHA256)
          .apply { if (strongBox && Build.VERSION.SDK_INT >= 28) setIsStrongBoxBacked(true) }
          .build()
      )
    }.generateKeyPair()

  fun exists(): Boolean = keystore().containsAlias(ALIAS)

  fun drop() {
    val ks = keystore()
    if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
  }

  /** `data` signed, as r‖s; null without a key. */
  fun sign(data: ByteArray): String? {
    val key = keystore().getKey(ALIAS, null) as? PrivateKey ?: return null
    val der = Signature.getInstance("SHA256withECDSA").run {
      initSign(key)
      update(data)
      sign()
    }
    return b64url(derToRaw(der))
  }

  /** 0x04 ‖ X ‖ Y, 32 bytes each. */
  private fun rawPoint(pub: ECPublicKey): ByteArray =
    byteArrayOf(4) + fixed(pub.w.affineX) + fixed(pub.w.affineY)

  private fun fixed(n: BigInteger): ByteArray {
    val b = n.toByteArray()
    return when {
      b.size == 32 -> b
      b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
      else -> ByteArray(32 - b.size) + b
    }
  }

  /** A DER `SEQUENCE { INTEGER r, INTEGER s }` as 64 bytes. */
  fun derToRaw(der: ByteArray): ByteArray {
    var i = 2
    if (der[1].toInt() and 0x80 != 0) i += der[1].toInt() and 0x7f
    fun int(): BigInteger {
      require(der[i].toInt() == 2) { "not a DER integer" }
      val len = der[i + 1].toInt()
      val v = BigInteger(1, der.copyOfRange(i + 2, i + 2 + len))
      i += 2 + len
      return v
    }
    val r = int()
    val s = int()
    return fixed(r) + fixed(s)
  }
}

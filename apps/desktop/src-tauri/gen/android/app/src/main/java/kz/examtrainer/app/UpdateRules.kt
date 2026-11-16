package kz.examtrainer.app

import java.net.URI
import java.security.MessageDigest

/**
 * The checks of an app update that need no Android: which versions count as newer, which addresses may be fetched,
 * what a release manifest entry must look like and when two sets of signing certificates are the same.
 * Kept apart from AppUpdates so plain JVM tests can cover them.
 */
object UpdateRules {
  /** latest.json is a few hundred bytes; anything far larger is not a manifest. */
  const val MAX_MANIFEST_BYTES = 64 * 1024
  /** The universal APK is about 17 MB; the cap only stops a runaway download. */
  const val MAX_APK_BYTES = 150L * 1024 * 1024

  /** GitHub serves release files from these hosts after a redirect from github.com. */
  private val HOSTS = setOf("github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com")
  private val MANIFEST = Regex("""^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/releases/latest/download/[A-Za-z0-9_.-]+$""")
  private val VERSION = Regex("""^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$""")
  private val FILE = Regex("""^[A-Za-z0-9_.-]+\.apk$""")
  private val SHA256 = Regex("""^[0-9a-f]{64}$""")

  /** The folder of tagged release files next to the manifest: only files from there are downloaded. Null turns updates off. */
  fun assetPrefix(manifestUrl: String): String? =
    MANIFEST.matchEntire(manifestUrl)?.let { "https://github.com/${it.groupValues[1]}/${it.groupValues[2]}/releases/download/" }

  /** Plain `major.minor.patch` (a leading "v" allowed); anything else is not a version this app installs. */
  fun parseVersion(text: String): List<Long>? =
    VERSION.matchEntire(text.trim().removePrefix("v"))?.groupValues?.drop(1)?.map { it.toLong() }

  fun isNewer(candidate: String, current: String): Boolean {
    val a = parseVersion(candidate) ?: return false
    val b = parseVersion(current) ?: return false
    for (i in 0..2) if (a[i] != b[i]) return a[i] > b[i]
    return false
  }

  /** The downloaded APK is the version the manifest announced and a newer build than the installed one: an older signed APK cannot ride on a newer tag. */
  fun isAnnouncedBuild(versionName: String?, versionCode: Long, installedCode: Long, announced: String): Boolean =
    versionName != null && parseVersion(versionName) != null && parseVersion(versionName) == parseVersion(announced) && versionCode > installedCode

  /** The APK of the announced version must sit under that version's tag, so a manifest cannot point at another release's file. */
  fun isAllowedAsset(url: String, prefix: String, version: String): Boolean {
    val tagged = prefix + "v" + version.removePrefix("v") + "/"
    return url.startsWith(tagged) && FILE.matches(url.removePrefix(tagged))
  }

  /** Only HTTPS to GitHub's own hosts, also after redirects. */
  fun isAllowedHost(url: String): Boolean = try {
    val uri = URI(url)
    uri.scheme == "https" && uri.host in HOSTS && uri.userInfo == null && (uri.port == -1 || uri.port == 443)
  } catch (e: Exception) {
    false
  }

  fun isSha256(text: String): Boolean = SHA256.matches(text)

  fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

  /** Both sides signed, and by exactly the same certificates. */
  fun sameSigners(a: List<ByteArray>, b: List<ByteArray>): Boolean {
    if (a.isEmpty() || b.isEmpty()) return false
    val digest = { cert: ByteArray -> hex(MessageDigest.getInstance("SHA-256").digest(cert)) }
    return a.map(digest).toSet() == b.map(digest).toSet()
  }
}

package kz.examtrainer.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.DigestInputStream
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Updates of the Android app from the project's GitHub Releases, offered to the page as `window.ExamUpdates`.
 *
 * The page only asks to check, to install or to open the system permission; every address comes from
 * BuildConfig.UPDATE_MANIFEST (plugins.updater.endpoints in tauri.conf.json) and the manifest it names.
 * Before the system installer sees a file it must match the manifest's size and SHA-256 (the file is whole),
 * be this app in the announced version with a higher version code, and be signed by the same certificate as the installed app
 * (it is ours: the release key never leaves the developer). The system checks the signature once more on install.
 * Network and disk work runs on one background thread; the page hears about it through `exam-update` events.
 */
class AppUpdates(private val activity: Activity, private val page: () -> WebView?) {
  private class Candidate(val version: String, val url: String, val sha256: String, val size: Long)

  private val worker = Executors.newSingleThreadExecutor()
  private val busy = AtomicBoolean(false)
  /** Lazy: the activity creates this object before it has a context to ask for its cache folder. */
  private val dir by lazy { File(activity.cacheDir, "updates") }
  private val current = BuildConfig.VERSION_NAME
  private val prefix = UpdateRules.assetPrefix(BuildConfig.UPDATE_MANIFEST)

  @Volatile private var candidate: Candidate? = null
  @Volatile private var state = phase(if (prefix == null) "off" else "idle")
  /** Set when the activity is destroyed (a font or display size change recreates it): a running download stops at its next read. */
  @Volatile private var closing = false

  val bridge = Bridge()

  inner class Bridge {
    @JavascriptInterface fun state(): String = state.toString()
    // `launch`, not `run`: inside this inner class `run { }` would be the standard library's, which calls the job right here
    // on the bridge thread, so the page would wait for the whole download and a second tap would start a second one.
    @JavascriptInterface fun check() = launch { checkNow() }
    @JavascriptInterface fun install() = launch { installNow() }
    /** Opens the system page where this app may be allowed to install apps; coming back resumes the install (see resumed). */
    @JavascriptInterface fun allowInstalls() {
      if (Build.VERSION.SDK_INT < 26) return
      startSafely(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
    }
  }

  /** Called from onResume: after the user allowed installs in the system settings, the verified file goes on to the installer. */
  fun resumed() {
    if (state.optString("phase") == "permission" && canInstall()) launch { installNow() }
  }

  /** Called from onDestroy: the worker thread goes with the activity that made it. */
  fun closed() {
    closing = true
    worker.shutdownNow()
  }

  /**
   * One job at a time; a tap while one runs is ignored, the page already shows its progress.
   * The job returns its final state (or null when it has none to report), which goes out only after `busy` is released:
   * the page may answer it at once (an automatic install), and that request must not find this job still running and be dropped.
   */
  private fun launch(job: () -> JSONObject?) {
    if (prefix == null || !busy.compareAndSet(false, true)) return
    try {
      worker.execute {
        val last = try {
          job()
        } catch (e: Exception) {
          // No installer to open, a file the provider refuses and the like: the page gets an error state, not a crashed app.
          failed("error")
        } finally {
          busy.set(false)
        }
        last?.let { emit(it) }
      }
    } catch (e: RejectedExecutionException) {
      busy.set(false)
    }
  }

  private fun checkNow(): JSONObject {
    emit(phase("checking"))
    return try {
      val found = fetchCandidate()
      candidate = found
      clearOldFiles(found)
      when {
        found == null -> phase("latest")
        verifiedFile(found) != null -> available(found, "ready")
        else -> available(found, "available")
      }
    } catch (e: FileNotFoundException) {
      phase("latest") // 404: no release with a manifest yet
    } catch (e: IOException) {
      failed("network")
    } catch (e: JSONException) {
      failed("manifest")
    } catch (e: IllegalStateException) {
      failed("manifest")
    }
  }

  private fun installNow(): JSONObject? {
    val found = candidate ?: return null
    return try {
      // Busy from the tap on, before a kept file is hashed or the first bytes arrive: until then the page would still offer the version
      // and let a test start under the installer. A kept file of the announced size shows as downloaded while it is checked.
      val cached = fileFor(found)
      emit(available(found, "downloading").put("received", if (cached.isFile && cached.length() == found.size) found.size else 0L))
      val file = verifiedFile(found) ?: download(found)
      when {
        !isOurUpdate(file, found) -> {
          file.delete()
          failed("signature")
        }
        !canInstall() -> available(found, "permission")
        else -> {
          // `ready` goes out first: if the installer cannot start, its error arrives after it and stays on screen.
          emit(available(found, "ready"))
          launchInstaller(file)
          null
        }
      }
    } catch (e: SecurityException) {
      failed("integrity")
    } catch (e: IOException) {
      failed("network")
    }
  }

  /** The newer Android build the manifest announces, or null when this app is up to date or the release has no Android file. */
  private fun fetchCandidate(): Candidate? {
    val json = JSONObject(String(fetch(BuildConfig.UPDATE_MANIFEST, UpdateRules.MAX_MANIFEST_BYTES.toLong()), Charsets.UTF_8))
    val version = json.getString("version").removePrefix("v")
    check(UpdateRules.parseVersion(version) != null) { "bad version" }
    if (!UpdateRules.isNewer(version, current)) return null
    val entry = json.getJSONObject("platforms").optJSONObject("android") ?: return null
    val found = Candidate(version, entry.getString("url"), entry.getString("sha256").lowercase(), entry.getLong("size"))
    check(UpdateRules.isAllowedAsset(found.url, prefix!!, version)) { "file outside the release" }
    check(UpdateRules.isSha256(found.sha256) && found.size in 1..UpdateRules.MAX_APK_BYTES) { "bad file entry" }
    return found
  }

  private fun fileFor(found: Candidate) = File(dir, "exam-trainer-${found.version}.apk")

  /** A file downloaded earlier for this version that still matches the manifest, so a second tap does not download again. */
  private fun verifiedFile(found: Candidate): File? {
    val file = fileFor(found)
    if (!file.isFile || file.length() != found.size) return null
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { DigestInputStream(it, digest).use { stream -> stream.copyTo(NullSink) } }
    return if (UpdateRules.hex(digest.digest()) == found.sha256) file else null.also { file.delete() }
  }

  /** Files of other versions are leftovers: an installed update, or a release that was replaced. */
  private fun clearOldFiles(found: Candidate?) {
    // A closing instance would delete the download of the activity that replaced it.
    if (closing) return
    val keep = found?.let { fileFor(it).name }
    dir.listFiles()?.forEach { if (it.name != keep) it.delete() }
  }

  /** Streams the APK to app-private storage, counting and hashing on the way; a file that does not match is never kept. */
  private fun download(found: Candidate): File {
    dir.mkdirs()
    // Named per instance: after the activity is recreated, the old job's cleanup cannot delete the new job's file.
    val part = File(dir, "download-${System.identityHashCode(this)}.part")
    val digest = MessageDigest.getInstance("SHA-256")
    val deadline = SystemClock.elapsedRealtime() + DOWNLOAD_DEADLINE_MS
    var received = 0L
    var reported = 0L
    var kept = false
    try {
      open(found.url).use { input ->
        part.outputStream().use { out ->
          val buffer = ByteArray(64 * 1024)
          DigestInputStream(input, digest).use { stream ->
            while (true) {
              val read = stream.read(buffer)
              if (read < 0) break
              if (closing) throw IOException("the app was closed")
              received += read
              if (received > found.size) throw SecurityException("larger than announced")
              // A server that trickles bytes would keep each read alive; the whole download still has a limit.
              if (SystemClock.elapsedRealtime() > deadline) throw IOException("download too slow")
              out.write(buffer, 0, read)
              if (received - reported >= PROGRESS_STEP || received == found.size) {
                reported = received
                emit(available(found, "downloading").put("received", received))
              }
            }
          }
        }
      }
      if (received != found.size || UpdateRules.hex(digest.digest()) != found.sha256) throw SecurityException("size or hash differs from the manifest")
      if (closing) throw IOException("the app was closed")
      val file = fileFor(found)
      if (!part.renameTo(file)) throw IOException("cannot keep the download")
      kept = true
      return file
    } finally {
      if (!kept) part.delete()
    }
  }

  /** This app, the announced version with a higher version code, signed with the very certificates of the installed app. */
  @Suppress("DEPRECATION")
  private fun isOurUpdate(file: File, found: Candidate): Boolean {
    val pm = activity.packageManager
    val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
    val archive = pm.getPackageArchiveInfo(file.path, flags) ?: return false
    val installed = pm.getPackageInfo(activity.packageName, flags)
    return archive.packageName == activity.packageName &&
      UpdateRules.isAnnouncedBuild(archive.versionName, PackageInfoCompat.getLongVersionCode(archive), PackageInfoCompat.getLongVersionCode(installed), found.version) &&
      UpdateRules.sameSigners(signers(archive), signers(installed))
  }

  @Suppress("DEPRECATION")
  private fun signers(info: PackageInfo): List<ByteArray> =
    if (Build.VERSION.SDK_INT >= 28) {
      val signing = info.signingInfo ?: return emptyList()
      (if (signing.hasMultipleSigners()) signing.apkContentsSigners else signing.signingCertificateHistory)?.map { it.toByteArray() } ?: emptyList()
    } else {
      info.signatures?.map { it.toByteArray() } ?: emptyList()
    }

  private fun canInstall() = Build.VERSION.SDK_INT < 26 || activity.packageManager.canRequestPackageInstalls()

  private fun launchInstaller(file: File) {
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
    val intent = Intent(Intent.ACTION_VIEW)
      .setDataAndType(uri, "application/vnd.android.package-archive")
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    startSafely(intent)
  }

  /** Runs on the UI thread, outside launch's catch: a device without an installer or that settings page gets an error state, not a crash. */
  private fun startSafely(intent: Intent) = activity.runOnUiThread {
    if (closing) return@runOnUiThread
    try {
      activity.startActivity(intent)
    } catch (e: ActivityNotFoundException) {
      emit(failed("error"))
    }
  }

  private fun fetch(url: String, limit: Long): ByteArray = open(url).use { input ->
    val bytes = input.readBytes(limit + 1)
    if (bytes.size > limit) throw IOException("response too large")
    bytes
  }

  /** Opens a GET on GitHub's hosts only, following at most a few redirects and checking each target. */
  private fun open(start: String): InputStream {
    var url = start
    repeat(MAX_REDIRECTS + 1) {
      if (!UpdateRules.isAllowedHost(url)) throw IOException("host not allowed")
      val connection = URL(url).openConnection() as HttpURLConnection
      connection.instanceFollowRedirects = false
      connection.connectTimeout = 15_000
      connection.readTimeout = 30_000
      connection.useCaches = false
      when (val code = connection.responseCode) {
        HttpURLConnection.HTTP_OK -> return connection.inputStream
        HttpURLConnection.HTTP_NOT_FOUND -> throw FileNotFoundException(url)
        in 300..399 -> {
          val location = connection.getHeaderField("Location") ?: throw IOException("redirect without a target")
          url = URL(URL(url), location).toString()
          connection.disconnect()
        }
        else -> throw IOException("HTTP $code")
      }
    }
    throw IOException("too many redirects")
  }

  private fun phase(name: String) = JSONObject().put("phase", name).put("current", current)

  private fun available(found: Candidate, name: String) = phase(name).put("version", found.version).put("size", found.size)

  private fun failed(reason: String) = phase("failed").put("reason", reason)

  /** Keeps the state for `state()` and tells the page; the JSON goes in as an object literal, never as code from the network. */
  private fun emit(next: JSONObject) {
    state = next
    if (closing) return
    val script = "window.dispatchEvent(new CustomEvent('exam-update',{detail:$next}))"
    activity.runOnUiThread { page()?.evaluateJavascript(script, null) }
  }

  private object NullSink : java.io.OutputStream() {
    override fun write(b: Int) {}
    override fun write(b: ByteArray, off: Int, len: Int) {}
  }

  private companion object {
    const val MAX_REDIRECTS = 5
    /** One progress event per this many bytes: enough for a smooth bar without flooding the page. */
    const val PROGRESS_STEP = 256L * 1024
    /** The desktop app gives its download the same ten minutes. */
    const val DOWNLOAD_DEADLINE_MS = 10L * 60 * 1000
  }
}

/** Reads at most `limit` bytes, so an endless response cannot fill the memory. */
private fun InputStream.readBytes(limit: Long): ByteArray {
  val out = java.io.ByteArrayOutputStream()
  val buffer = ByteArray(8 * 1024)
  var total = 0L
  while (total < limit) {
    val read = read(buffer, 0, minOf(buffer.size.toLong(), limit - total).toInt())
    if (read < 0) break
    out.write(buffer, 0, read)
    total += read
  }
  return out.toByteArray()
}

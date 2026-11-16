package kz.examtrainer.app

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat

class MainActivity : TauriActivity() {
  private var page: WebView? = null
  private val updates = AppUpdates(this) { page }

  /** Enabled only while the page holds an exam with answers: then Back is the page's to answer ("leave?"), not a step back in history or the end of the app. */
  private val examBack = object : OnBackPressedCallback(false) {
    override fun handleOnBackPressed() {
      page?.evaluateJavascript("window.examBack && window.examBack()", null)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    page = webView
    webView.addJavascriptInterface(SystemBars(), "ExamSystemBars")
    webView.addJavascriptInterface(updates.bridge, "ExamUpdates")
    // Added after the callback that goes back in history (registered by the Tauri app plugin), so it is asked first.
    onBackPressedDispatcher.addCallback(this, examBack)
  }

  override fun onResume() {
    super.onResume()
    updates.resumed()
  }

  override fun onDestroy() {
    updates.closed()
    super.onDestroy()
  }

  /** What the page asks of the Android shell: icons of the system bars for its theme, and the Back button during an exam. */
  private inner class SystemBars {
    @JavascriptInterface
    fun setDark(dark: Boolean) {
      runOnUiThread {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = !dark
        controller.isAppearanceLightNavigationBars = !dark
      }
    }

    @JavascriptInterface
    fun holdBack(hold: Boolean) {
      runOnUiThread { examBack.isEnabled = hold }
    }
  }
}

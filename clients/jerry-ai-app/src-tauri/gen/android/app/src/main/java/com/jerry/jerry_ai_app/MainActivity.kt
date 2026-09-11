package com.jerry.jerry_ai_app

import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {

  private var cachedWebView: WebView? = null
  private var lastTop = 0
  private var lastBottom = 0

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      // Android 11+：沉浸式（内容延伸到系统栏底下，背景铺满）+ 原生 insets 桥。
      // 为什么不靠 CSS env(safe-area-inset-*)：部分厂商 WebView/平板上该值恒为 0，
      // 导致侧边栏/面板底部仍被导航栏遮挡（issue：平板与个别机型超出底部栏）。
      // 改为原生监听 WindowInsets，把系统栏/刘海/键盘高度注入为 CSS 变量，
      // Web 层所有布局统一用 var(--safe-*) 避让，一处注入全站生效。
      enableEdgeToEdge()
      WindowCompat.setDecorFitsSystemWindows(window, false)
      ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
        val bars = insets.getInsets(
          WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
        )
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        lastTop = bars.top
        // 键盘弹出时 bottom 取「导航栏 vs 键盘」更高者，输入框/侧边栏底部随之抬升，不被键盘遮挡
        lastBottom = maxOf(bars.bottom, ime.bottom)
        applyToWeb()
        insets
      }
      // WebView 由 Tauri 异步创建，页面加载晚于首个 insets 事件；
      // 错峰补发几次，确保变量在页面就绪后一定能注入
      window.decorView.postDelayed({ applyToWeb() }, 600)
      window.decorView.postDelayed({ applyToWeb() }, 2000)
      window.decorView.postDelayed({ applyToWeb() }, 4000)
    }
    // Android 10 及以下：保持传统 fitsSystemWindows（窗口不与系统栏重叠，天然无遮挡），
    // 键盘靠 manifest 的 adjustResize 自动压缩窗口；老机型放弃沉浸式换取稳定
  }

  /** 把最近一次计算的 insets 以 CSS 变量形式注入页面根元素 */
  private fun applyToWeb() {
    val web = cachedWebView ?: findWebView(window.decorView)?.also { cachedWebView = it } ?: return
    web.evaluateJavascript(
      "document.documentElement.style.setProperty('--safe-top','${lastTop}px');" +
        "document.documentElement.style.setProperty('--safe-bottom','${lastBottom}px');",
      null
    )
  }

  /** 深度优先查找 Tauri 创建的 WebView（异步加入视图树，需惰性缓存） */
  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) {
        findWebView(view.getChildAt(i))?.let { return it }
      }
    }
    return null
  }
}

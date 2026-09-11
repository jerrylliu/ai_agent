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
  private var lastKeyboard = 0

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
        // 具体数值统一由 applyToWeb() 实时查询，监听器只负责触发注入
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

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // ColorOS 等厂商 ROM 偶发丢失「键盘收起」的 insets 分发事件，导致高度变量卡在
    // 键盘值、输入框悬在屏幕中部（issue：一加 ACE 5）。键盘收起必然伴随窗口焦点
    // 回归，此时主动重查当前 insets 并重注入，是可靠的自愈路径
    if (hasFocus && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      applyToWeb()
    }
  }

  /**
   * 把当前 insets 以 CSS 变量形式注入页面根元素。
   * 关键设计：不回放缓存旧值，而是每次实时查询系统「此刻」的 insets——
   * 即使某次事件分发丢失，注入的也是真实状态，天然自愈；
   * 缓存值仅作为 rootWindowInsets 查询失败时的兜底。
   */
  private fun applyToWeb() {
    val web = cachedWebView ?: findWebView(window.decorView)?.also { cachedWebView = it } ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      ViewCompat.getRootWindowInsets(window.decorView)?.let { cur ->
        val bars = cur.getInsets(
          WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
        )
        val ime = cur.getInsets(WindowInsetsCompat.Type.ime())
        lastTop = bars.top
        // 拆成两个变量：--safe-bottom 只承载系统栏（小而稳定，绝不会被键盘高度污染）；
        // 键盘单独走 --safe-keyboard。曾把 max(导航栏, 键盘) 合进一个变量，
        // 厂商 ROM 丢一次「键盘收起」事件就永久卡死（一加 ACE 5 收缩在一起、荣耀正常）
        lastBottom = bars.bottom
        lastKeyboard = maxOf(0, ime.bottom - bars.bottom)
      }
    }
    web.evaluateJavascript(
      "document.documentElement.style.setProperty('--safe-top','${lastTop}px');" +
        "document.documentElement.style.setProperty('--safe-bottom','${lastBottom}px');" +
        "document.documentElement.style.setProperty('--safe-keyboard','${lastKeyboard}px');",
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

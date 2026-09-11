package com.jerry.jerry_ai_app

import android.os.Build
import android.os.Bundle
import android.util.Log
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
  private var lastLeft = 0
  private var lastRight = 0
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

  /**
   * 【L3 时序自愈 · 第二条路径】从后台回到前台时重查一次。
   * 分屏、旋转、沉浸式状态变化都可能在这期间改变 insets，厂商 ROM 也可能在这段时间
   * 丢事件；onResume 是「必然发生」的时机，与 onWindowFocusChanged 互为补充。
   * 间隔 300ms 再补发一次，是为了等系统完成窗口重新布局后再取一次真实值。
   */
  override fun onResume() {
    super.onResume()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      applyToWeb()
      window.decorView.postDelayed({ applyToWeb() }, 300)
    }
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // 【L3 时序自愈 · 第一条路径】ColorOS 等厂商 ROM 偶发丢失「键盘收起」的 insets
    // 分发事件，导致高度变量卡在键盘值、输入框悬在屏幕中部（issue：一加 ACE 5）。
    // 键盘收起必然伴随窗口焦点回归，此时主动重查当前 insets 并重注入，是可靠的自愈路径
    if (hasFocus && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      applyToWeb()
    }
  }

  /**
   * 把当前 insets 以 CSS 变量形式注入页面根元素。
   *
   * 关键设计一（实时查询）：不回放缓存旧值，而是每次实时查询系统「此刻」的 insets——
   * 即使某次事件分发丢失，注入的也是真实状态，天然自愈；
   * 缓存值仅作为 rootWindowInsets 查询失败时的兜底。
   *
   * 关键设计二（L1 只注入候选值）：写入的是 --native-safe-*（候选值），不是最终值。
   * 最终值由 CSS 侧 clamp(max(env(...), var(--native-safe-*))) 合成 —— 原生桥坏掉时
   * 浏览器原生 env() 这一路会自动接管，恢复「注入失败也只是少一点避让」的优雅降级。
   * 早期版本直接覆写 --safe-*，一旦注入错值没有任何兜底（整屏收缩事故的成因之一）。
   */
  private fun applyToWeb() {
    val web = cachedWebView ?: findWebView(window.decorView)?.also { cachedWebView = it } ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val metrics = resources.displayMetrics
      // 【必须做密度换算】WindowInsets 返回的是物理像素(px)，而 WebView 里 CSS 的 px 是
      // 设备无关像素(dp)，两者相差 density 倍（手机 2.75~3.5、平板 1.5~2）。
      // 不换算就直接注入，等于把安全区放大约 3 倍：状态栏 24dp 被写成 72px、
      // 键盘 300dp 被写成 900px，页面被整体顶开挤成一团（issue：OPPO/一加 ACE 5、平板）。
      // density 理论上恒 > 0，这里仍做除零保护，避免极端机型出现 Infinity
      val density = if (metrics.density > 0f) metrics.density else 1f
      val screenWDp = metrics.widthPixels / density
      val screenHDp = metrics.heightPixels / density
      ViewCompat.getRootWindowInsets(window.decorView)?.let { cur ->
        val bars = cur.getInsets(
          WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
        )
        val ime = cur.getInsets(WindowInsetsCompat.Type.ime())
        // 【L2 合法性闸门】每个值都要过一遍合理性检查再注入，见 sanitize()
        lastTop = sanitize((bars.top / density).toInt(), screenHDp, "top")
        // 拆成两个变量：--safe-bottom 只承载系统栏（小而稳定，绝不会被键盘高度污染）；
        // 键盘单独走 --safe-keyboard。曾把 max(导航栏, 键盘) 合进一个变量，
        // 厂商 ROM 丢一次「键盘收起」事件就永久卡死（一加 ACE 5 收缩在一起、荣耀正常）
        lastBottom = sanitize((bars.bottom / density).toInt(), screenHDp, "bottom")
        // 左右 insets：平板横屏时导航栏在侧边，右侧模型面板/左侧抽屉会被压住
        lastLeft = sanitize((bars.left / density).toInt(), screenWDp, "left")
        lastRight = sanitize((bars.right / density).toInt(), screenWDp, "right")
        lastKeyboard = sanitize(
          maxOf(0, ((ime.bottom - bars.bottom) / density).toInt()),
          screenHDp,
          "keyboard",
          ratio = 0.6f
        )
      }
    }
    web.evaluateJavascript(
      "document.documentElement.style.setProperty('--native-safe-top','${lastTop}px');" +
        "document.documentElement.style.setProperty('--native-safe-bottom','${lastBottom}px');" +
        "document.documentElement.style.setProperty('--native-safe-left','${lastLeft}px');" +
        "document.documentElement.style.setProperty('--native-safe-right','${lastRight}px');" +
        "document.documentElement.style.setProperty('--native-safe-keyboard','${lastKeyboard}px');",
      null
    )
  }

  /**
   * 【L2 合法性闸门】注入前的最后一次合理性校验。
   *
   * 系统栏 / 刘海 / 键盘的尺寸都是物理常量，不可能超过屏幕的一个很小比例。这里按比例
   * 设上限（系统栏与刘海 15%、键盘 60%），一旦越界就判定为「测量或换算出错」，宁可返回 0
   * （等于放弃这一路的避让，交给 CSS 侧的 env() 兜底）也绝不把错值灌进布局，同时打日志
   * 便于线上定位。这样即使测量链路再出一次单位错误，最坏结果也从「整屏收缩错位」降级为
   * 「顶部/底部少留一点白」。
   *
   * @param value 已换算为 dp 的待注入值
   * @param screenDp 屏幕在对应方向上的 dp 尺寸
   * @param name 变量名，仅用于日志
   * @param ratio 允许占屏幕的最大比例（系统栏 15%、键盘 60%）
   */
  private fun sanitize(value: Int, screenDp: Float, name: String, ratio: Float = 0.15f): Int {
    if (value <= 0) return 0
    val limit = screenDp * ratio
    if (value > limit) {
      Log.w(
        TAG,
        "安全区数值异常，已按 0 处理（交由 CSS env() 兜底）：$name=${value}dp，上限=${limit.toInt()}dp"
      )
      return 0
    }
    return value
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

  companion object {
    private const val TAG = "MainActivityInsets"
  }
}

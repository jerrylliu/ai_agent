package com.jerry.jerry_ai_app

import android.os.Bundle

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // 不启用 enableEdgeToEdge：启用后 WebView 内容会延伸到系统导航栏/手势条底下，
    // 导致底部按钮（设置等）被遮挡误触。默认 fitsSystemWindows 让系统自动避让。
    // 若将来要做沉浸式状态栏，需配合 WindowInsets 监听给 WebView 注入安全区 padding。
    super.onCreate(savedInstanceState)
  }
}

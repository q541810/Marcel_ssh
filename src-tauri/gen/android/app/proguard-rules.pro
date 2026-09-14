# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ── Rust 侧 JNI 反射调用的入口点：必须保留 ──────────────────────────────
#
# 调用方：src-tauri/src/updater/install.rs 的 `call_activity`。它从
# ndk_context 拿到 Activity，再用 JNI 按「方法名 + 签名」反射调用
# MainActivity 上那几个应用内更新方法（见 MainActivity.kt 的
# 「应用内更新（由 Rust 侧 JNI 调用）」段）。
#
# 这些方法不是 native 声明，wry 自动生成的 proguard-wry.pro 里
# `-keep class com.marcel.ssh.* { native <methods>; }` 覆盖不到，于是
# release 构建（isMinifyEnabled = true）里 R8 会把它们整个删掉 —— 是删除
# 不是改名，mapping.txt 里查无此名、usage.txt 里列着它们。运行时表现为
# NoSuchMethodError，前端只看到一句
# 「调用原生方法 installUpdateApk 失败: Java exception was thrown」。
# debug 构建 isMinifyEnabled = false，永远复现不出来：v1.4.1 的 release
# APK 真机上「立即安装」直接失败，就是这么来的。别只拿 debug 包验证更新链路。
#
# 下面按契约整类保留「返回 String 的公开方法」：call_activity 只支持
# `()Ljava/lang/String;` 和 `(Ljava/lang/String;)Ljava/lang/String;` 两种签名，
# 正好被这两条覆盖，所以新增同契约的方法不需要再动本文件。若要暴露别的签名
# （非 String 返回值、多参数），必须在这里补对应规则。
-keep class com.marcel.ssh.MainActivity {
    public java.lang.String *(java.lang.String);
    public java.lang.String *();
}
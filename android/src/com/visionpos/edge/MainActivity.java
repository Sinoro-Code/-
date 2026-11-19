package com.visionpos.edge;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * VisionPOS Edge — Universal Android Native Wrapper (Android 5.0 API 21 through Android 15/16+)
 * Compatible across Samsung OneUI, Google Pixel, OPPO ColorOS, vivo OriginOS, ASUS ZenUI,
 * Sony Xperia, Xiaomi/Redmi/POCO HyperOS/MIUI, Honor/Huawei, Motorola, Sharp, and Android POS terminals.
 *
 * Serves VisionPOS-Android.html over virtual HTTPS origin (https://visionpos.local/)
 * so WebRTC Live Camera, Torch, BarcodeDetector, IndexedDB, PrintManager, Vibrator,
 * and OEM Native Camera capture work 100% offline across all Android phones.
 */
public class MainActivity extends Activity {
    private static final int REQ_CAMERA_PERMISSION = 1001;
    private static final int REQ_FILE_CHOOSER = 1002;
    private static final String APP_URL = "https://visionpos.local/index.html?v=339";

    private WebView webView;
    private PermissionRequest pendingWebPermission;
    private ValueCallback<Uri[]> filePathCallback;
    private Uri pendingCameraCaptureUri;
    private File pendingCameraCaptureFile;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        if (window != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.setStatusBarColor(Color.parseColor("#0B0F14"));
            window.setNavigationBarColor(Color.parseColor("#0B0F14"));
        }

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0B0F14"));
        // Respect status bar, punch-hole/notch cutouts, and gesture navigation bar across Android 5-15+
        root.setFitsSystemWindows(true);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0B0F14"));
        configureWebView(webView);
        // Clear disk/RAM HTTP cache so APK updates always load the latest bundled HTML/JS/CSS
        // (localStorage and IndexedDB merchant inventory data remain 100% intact)
        webView.clearCache(true);

        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        setContentView(root);

        ensureCameraPermission();
        webView.loadUrl(APP_URL);
    }

    private boolean hasCameraPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true; // Granted at install time on Android 5.x (API 21-22)
        }
        return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    private void ensureCameraPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !hasCameraPermission()) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA_PERMISSION);
        }
    }

    private void grantUriToResolvedPackages(Intent intent, Uri uri, int flags) {
        if (intent == null || uri == null) return;
        try {
            List<ResolveInfo> resolved = getPackageManager().queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY);
            if (resolved != null) {
                for (ResolveInfo info : resolved) {
                    if (info.activityInfo != null && info.activityInfo.packageName != null) {
                        grantUriPermission(info.activityInfo.packageName, uri, flags);
                    }
                }
            }
        } catch (Exception ignored) {
        }
    }

    private WebResourceResponse openBundledAppResponse(Uri url) {
        if (url != null && "visionpos.local".equalsIgnoreCase(url.getHost())) {
            String path = url.getPath();
            if (path == null || path.isEmpty() || "/".equals(path) || "/index.html".equals(path)) {
                try {
                    InputStream is = getAssets().open("app-bundle.html");
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                        Map<String, String> headers = new HashMap<>();
                        headers.put("Access-Control-Allow-Origin", "*");
                        headers.put("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
                        headers.put("Pragma", "no-cache");
                        return new WebResourceResponse(
                                "text/html",
                                "UTF-8",
                                200,
                                "OK",
                                headers,
                                is
                        );
                    }
                    return new WebResourceResponse("text/html", "UTF-8", is);
                } catch (Exception e) {
                    return null;
                }
            }
        }
        return null;
    }

    private void configureWebView(WebView wv) {
        WebSettings settings = wv.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setTextZoom(100);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }

        wv.addJavascriptInterface(new AndroidBridge(), "VisionPOSAndroid");

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse bundled = openBundledAppResponse(request != null ? request.getUrl() : null);
                if (bundled != null) {
                    return bundled;
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            @SuppressWarnings("deprecation")
            public WebResourceResponse shouldInterceptRequest(WebView view, String urlStr) {
                if (urlStr != null) {
                    WebResourceResponse bundled = openBundledAppResponse(Uri.parse(urlStr));
                    if (bundled != null) {
                        return bundled;
                    }
                }
                return super.shouldInterceptRequest(view, urlStr);
            }
        });

        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    if (hasCameraPermission()) {
                        request.grant(request.getResources());
                    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        pendingWebPermission = request;
                        requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA_PERMISSION);
                    } else {
                        request.deny();
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(
                    WebView webView,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams fileChooserParams
            ) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;

                boolean captureRequested = fileChooserParams != null && fileChooserParams.isCaptureEnabled();
                String[] acceptTypes = fileChooserParams != null ? fileChooserParams.getAcceptTypes() : new String[0];
                boolean wantsImage = captureRequested;
                if (!wantsImage && acceptTypes != null) {
                    for (String t : acceptTypes) {
                        if (t != null && t.contains("image")) {
                            wantsImage = true;
                            break;
                        }
                    }
                }

                try {
                    Intent cameraIntent = null;
                    if (wantsImage) {
                        File captureDir = new File(getCacheDir(), "captures");
                        if (!captureDir.exists()) captureDir.mkdirs();
                        File[] oldFiles = captureDir.listFiles();
                        long cutoff = System.currentTimeMillis() - 600_000L;
                        if (oldFiles != null) {
                            for (File f : oldFiles) {
                                if (f.lastModified() < cutoff) {
                                    //noinspection ResultOfMethodCallIgnored
                                    f.delete();
                                }
                            }
                        }

                        String fileName = "snap_" + System.currentTimeMillis() + ".jpg";
                        pendingCameraCaptureFile = new File(captureDir, fileName);
                        pendingCameraCaptureUri = CaptureFileProvider.buildUriForFile("captures", fileName);

                        int permFlags = Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION;
                        cameraIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                        cameraIntent.putExtra(MediaStore.EXTRA_OUTPUT, pendingCameraCaptureUri);
                        cameraIntent.setClipData(ClipData.newRawUri("", pendingCameraCaptureUri));
                        cameraIntent.addFlags(permFlags);
                        // Explicit package grant for Huawei EMUI, older Samsung OneUI, ColorOS & Android 5-7 cameras
                        grantUriToResolvedPackages(cameraIntent, pendingCameraCaptureUri, permFlags);
                    }

                    if (captureRequested && cameraIntent != null) {
                        ensureCameraPermission();
                        try {
                            startActivityForResult(cameraIntent, REQ_FILE_CHOOSER);
                            return true;
                        } catch (ActivityNotFoundException ignored) {
                            // Fall through to document/gallery chooser if device has no camera app
                        }
                    }

                    Intent contentIntent = new Intent(Intent.ACTION_GET_CONTENT);
                    contentIntent.addCategory(Intent.CATEGORY_OPENABLE);
                    contentIntent.setType(wantsImage ? "image/*" : "*/*");

                    Intent chooser = Intent.createChooser(contentIntent, wantsImage ? "選擇商品照片或開啟相機" : "選擇匯入檔案");
                    if (cameraIntent != null) {
                        chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cameraIntent});
                    }
                    startActivityForResult(chooser, REQ_FILE_CHOOSER);
                    return true;
                } catch (Exception e) {
                    if (filePathCallback != null) {
                        filePathCallback.onReceiveValue(null);
                        filePathCallback = null;
                    }
                    Toast.makeText(MainActivity.this, "無法開啟相機或檔案選擇器: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_CAMERA_PERMISSION) {
            boolean granted = grantResults != null
                    && grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (pendingWebPermission != null) {
                if (granted) {
                    pendingWebPermission.grant(pendingWebPermission.getResources());
                } else {
                    pendingWebPermission.deny();
                }
                pendingWebPermission = null;
            }
            if (granted && webView != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                webView.evaluateJavascript("if(window.__resumeLiveCamera)window.__resumeLiveCamera();", null);
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE_CHOOSER) return;

        if (filePathCallback == null) return;
        Uri[] results = null;

        if (resultCode == Activity.RESULT_OK) {
            if (pendingCameraCaptureFile != null
                    && pendingCameraCaptureFile.exists()
                    && pendingCameraCaptureFile.length() > 0
                    && pendingCameraCaptureUri != null) {
                results = new Uri[]{pendingCameraCaptureUri};
            } else if (data != null) {
                if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                } else if (data.getClipData() != null && data.getClipData().getItemCount() > 0) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getExtras() != null && data.getExtras().get("data") instanceof Bitmap
                        && pendingCameraCaptureFile != null && pendingCameraCaptureUri != null) {
                    // Fallback for OEM cameras returning inline Bitmap thumbnail instead of EXTRA_OUTPUT
                    Bitmap bmp = (Bitmap) data.getExtras().get("data");
                    try (FileOutputStream fos = new FileOutputStream(pendingCameraCaptureFile)) {
                        bmp.compress(Bitmap.CompressFormat.JPEG, 92, fos);
                        results = new Uri[]{pendingCameraCaptureUri};
                    } catch (Exception ignored) {
                    }
                }
            }
        }

        pendingCameraCaptureFile = null;
        pendingCameraCaptureUri = null;
        filePathCallback.onReceiveValue(results);
        filePathCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (webView != null) {
            webView.evaluateJavascript(
                    "(function(){var m=document.getElementById('receipt-modal');if(m&&!m.classList.contains('hidden')){m.classList.add('hidden');return 'closed';}return '';})()",
                    val -> {
                        if (val != null && val.contains("closed")) return;
                        if (webView != null && webView.canGoBack()) {
                            webView.goBack();
                        } else {
                            MainActivity.super.onBackPressed();
                        }
                    }
            );
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            try {
                webView.loadUrl("about:blank");
                webView.destroy();
            } catch (Exception ignored) {
            }
            webView = null;
        }
        super.onDestroy();
    }

    public class AndroidBridge {
        @JavascriptInterface
        public String getDeviceInfo() {
            String brand = Build.BRAND != null ? Build.BRAND.trim() : "";
            String model = Build.MODEL != null ? Build.MODEL.trim() : "Android";
            String label = model;
            if (!brand.isEmpty() && !model.toLowerCase().startsWith(brand.toLowerCase())) {
                label = Character.toUpperCase(brand.charAt(0)) + brand.substring(1) + " " + model;
            }
            return label + " (Android " + Build.VERSION.RELEASE + ")";
        }

        @JavascriptInterface
        @SuppressWarnings("deprecation")
        public void vibrate(final int durationMs) {
            try {
                Vibrator vib = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                if (vib != null && vib.hasVibrator()) {
                    int ms = Math.max(10, Math.min(200, durationMs));
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        vib.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
                    } else {
                        vib.vibrate(ms);
                    }
                }
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        @SuppressWarnings("deprecation")
        public void printReceipt() {
            runOnUiThread(() -> {
                try {
                    if (webView == null) return;
                    PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                    if (pm != null) {
                        PrintDocumentAdapter adapter = Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP
                                ? webView.createPrintDocumentAdapter("VisionPOS_Receipt")
                                : webView.createPrintDocumentAdapter();
                        pm.print("VisionPOS 電子收據", adapter, new PrintAttributes.Builder().build());
                    }
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "無法啟動列印服務: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void saveTextFile(final String filename, final String content, final String mimeType) {
            runOnUiThread(() -> {
                try {
                    File exportDir = new File(getCacheDir(), "exports");
                    if (!exportDir.exists()) exportDir.mkdirs();
                    String safeName = new File(filename).getName();
                    File outFile = new File(exportDir, safeName);
                    try (FileOutputStream fos = new FileOutputStream(outFile)) {
                        fos.write(content.getBytes(StandardCharsets.UTF_8));
                    }
                    Uri uri = CaptureFileProvider.buildUriForFile("exports", safeName);
                    Intent share = new Intent(Intent.ACTION_SEND);
                    share.setType(mimeType != null ? mimeType.split(";")[0] : "text/plain");
                    share.putExtra(Intent.EXTRA_STREAM, uri);
                    share.setClipData(ClipData.newRawUri(safeName, uri));
                    share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    grantUriToResolvedPackages(share, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(Intent.createChooser(share, "儲存或分享匯出檔案：" + safeName));
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "匯出失敗: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                }
            });
        }
    }
}

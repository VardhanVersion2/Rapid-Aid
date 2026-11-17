package com.rapidaid.app;

import android.app.Activity;
import android.os.Bundle;
import android.os.Build;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.content.pm.PackageManager;
import android.content.Intent;
import android.net.Uri;
import android.content.SharedPreferences;
import android.app.AlertDialog;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.widget.EditText;
import android.widget.Toast;
import android.widget.FrameLayout;

public class MainActivity extends Activity {
    private WebView webView;
    private SharedPreferences preferences;
    private static final String PREF_SERVER = "server_url";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        preferences = getSharedPreferences("rapidaid", MODE_PRIVATE);

        // Request runtime permissions if Android 6.0+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            String[] perms = {
                "android.permission.ACCESS_FINE_LOCATION",
                "android.permission.ACCESS_COARSE_LOCATION",
                "android.permission.RECORD_AUDIO",
                "android.permission.CAMERA"
            };
            boolean needReq = false;
            for (String p : perms) {
                if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) {
                    needReq = true;
                    break;
                }
            }
            if (needReq) {
                requestPermissions(perms, 101);
            }
        }

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setGeolocationEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1) {
            s.setMediaPlaybackRequiresUserGesture(false);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url.startsWith("tel:") || url.startsWith("geo:") || url.startsWith("mailto:")) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) {}
                    return true;
                }
                return false;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                boolean allowed = checkSelfPermission("android.permission.ACCESS_FINE_LOCATION") == PackageManager.PERMISSION_GRANTED
                    || checkSelfPermission("android.permission.ACCESS_COARSE_LOCATION") == PackageManager.PERMISSION_GRANTED;
                callback.invoke(origin, allowed, false);
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    boolean audioAllowed = checkSelfPermission("android.permission.RECORD_AUDIO") == PackageManager.PERMISSION_GRANTED;
                    if (audioAllowed) request.grant(request.getResources());
                    else request.deny();
                }
            }
        });

        // Set full screen layout
        setContentView(webView);

        String server = preferences.getString(PREF_SERVER, "");
        if (server.isEmpty()) showServerDialog(); else connect(server);
    }

    @Override public boolean onCreateOptionsMenu(Menu menu) {
        menu.add("Change server");
        return true;
    }

    @Override public boolean onOptionsItemSelected(MenuItem item) {
        if ("Change server".contentEquals(item.getTitle())) { showServerDialog(); return true; }
        return super.onOptionsItemSelected(item);
    }

    private void showServerDialog() {
        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint("http://192.168.1.10:3000");
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(preferences.getString(PREF_SERVER, ""));
        new AlertDialog.Builder(this)
            .setTitle("Connect to RapidAid server")
            .setMessage("Enter the address of the computer running RapidAid. Phone and computer should use the same network.")
            .setView(input)
            .setCancelable(false)
            .setPositiveButton("Connect", (dialog, which) -> connect(input.getText().toString().trim()))
            .setNegativeButton("Exit", (dialog, which) -> finish())
            .show();
    }

    private void connect(String server) {
        if (!server.startsWith("http://") && !server.startsWith("https://")) server = "http://" + server;
        while (server.endsWith("/")) server = server.substring(0, server.length() - 1);
        if (server.length() < 9) { Toast.makeText(this, "Enter a valid server address", Toast.LENGTH_LONG).show(); showServerDialog(); return; }
        preferences.edit().putString(PREF_SERVER, server).apply();
        webView.loadUrl(server);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            showServerDialog();
        }
    }
}


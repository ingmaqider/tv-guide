package io.github.ingmaqider.tvguide;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

/**
 * A remote for TV Guide on the desktop: asks once for the computer's IP address, then shows
 * the app that the desktop serves to phones (http://IP:47832) in a WebView. Pairing, data
 * and controls all come from that page; this adds what a page can't do: the hardware volume
 * keys for VLC, the device name, and changing the address.
 */
public class MainActivity extends Activity {
    // The desktop app's phone listener (REMOTE_PORT in server/index.js).
    private static final int PORT = 47832;
    private static final String PREFS = "tvguide";
    private static final String KEY_HOST = "host";
    // An IPv4 address, optionally with a port. The desktop only answers requests addressed
    // to an IP (it refuses host names, see server/index.js).
    private static final Pattern ADDRESS = Pattern.compile("^(\\d{1,3}\\.){3}\\d{1,3}(:\\d{1,5})?$");

    private SharedPreferences prefs;
    private FrameLayout root;
    private WebView web;
    private String host;
    // Set by the page while VLC is open (player.jsx): the volume keys then control VLC.
    private volatile boolean volumeKeys = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        root = new FrameLayout(this);
        // Android 15 draws apps edge to edge: keep content clear of the status and
        // navigation bars, and of the keyboard.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        setContentView(root);

        host = prefs.getString(KEY_HOST, null);
        if (host == null) showSetup(null);
        else showWeb();
    }

    private String baseUrl() {
        return "http://" + (host.contains(":") ? host : host + ":" + PORT);
    }

    // --- Screens ---

    private int color(int id) {
        return getColor(id);
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    private LinearLayout page() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(dp(24), dp(32), dp(24), dp(24));
        layout.setBackgroundColor(color(R.color.bg));
        TextView title = text("TV Guide", 24, R.color.text);
        title.setPadding(0, 0, 0, dp(12));
        layout.addView(title);
        return layout;
    }

    private TextView text(String value, int sp, int colorId) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setTextColor(color(colorId));
        view.setPadding(0, 0, 0, dp(8));
        return view;
    }

    private void show(View view) {
        root.removeAllViews();
        root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    // Asks for the computer's IP address and checks that TV Guide answers there.
    private void showSetup(String error) {
        volumeKeys = false;
        LinearLayout layout = page();
        layout.addView(text("Enter the IP address of the computer running TV Guide. You'll find it in TV Guide "
                + "on the computer: click Phone and turn on \"Let phones on this network control TV Guide\".", 16, R.color.text));

        EditText input = new EditText(this);
        input.setHint("192.168.1.10");
        input.setSingleLine();
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setImeOptions(EditorInfo.IME_ACTION_GO);
        input.setTextColor(color(R.color.text));
        input.setHintTextColor(color(R.color.muted));
        if (host != null) input.setText(host);
        layout.addView(input);

        TextView message = text(error != null ? error : "", 15, R.color.error);
        Button connect = new Button(this);
        connect.setText("Connect");
        Runnable go = () -> {
            String address = input.getText().toString().trim();
            if (!ADDRESS.matcher(address).matches()) {
                message.setText("That doesn't look like an IP address. It's four numbers with dots, like 192.168.1.10.");
                return;
            }
            connect.setEnabled(false);
            message.setTextColor(color(R.color.muted));
            message.setText("Connecting…");
            check(address, (problem) -> {
                connect.setEnabled(true);
                if (problem != null) {
                    message.setTextColor(color(R.color.error));
                    message.setText(problem);
                    return;
                }
                host = address;
                prefs.edit().putString(KEY_HOST, address).apply();
                showWeb();
            });
        };
        connect.setOnClickListener(v -> go.run());
        input.setOnEditorActionListener((v, actionId, event) -> {
            go.run();
            return true;
        });
        layout.addView(connect);

        // Or scan the QR code in TV Guide's Phone panel: address and pairing in one go.
        layout.addView(text("Or click Phone in TV Guide on the computer and scan the QR code shown there:", 16, R.color.text));
        Button scan = new Button(this);
        scan.setText("Scan QR code");
        scan.setOnClickListener(v -> scanQr(message));
        layout.addView(scan);

        layout.addView(message);
        show(layout);
        input.requestFocus();
    }

    // Google Play services' scanner (no camera permission needed); not on phones without
    // Play services, where typing the address still works.
    private void scanQr(TextView message) {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build();
        GmsBarcodeScanning.getClient(this, options).startScan()
                .addOnSuccessListener(barcode -> onScanned(barcode.getRawValue(), message))
                .addOnFailureListener(e -> {
                    message.setTextColor(color(R.color.error));
                    message.setText("Couldn't scan: " + e.getMessage() + ". Type the address instead.");
                });
    }

    // The QR code is a link: http://<IP>:<port>/?pair=<one-time code>. Opening the page with
    // it pairs the phone without the Allow step on the computer (see phone.jsx).
    private void onScanned(String raw, TextView message) {
        Uri link = Uri.parse(raw == null ? "" : raw);
        String code = null;
        try {
            code = link.getQueryParameter("pair");
        } catch (UnsupportedOperationException e) {
            // Not a link at all.
        }
        String ip = link.getHost();
        if (!"http".equals(link.getScheme()) || ip == null || code == null || !ADDRESS.matcher(ip).matches()) {
            message.setTextColor(color(R.color.error));
            message.setText("That isn't a TV Guide pairing code. Click Phone in TV Guide on the computer and scan the code there.");
            return;
        }
        String address = link.getPort() == -1 || link.getPort() == PORT ? ip : ip + ":" + link.getPort();
        String pairPath = "/?pair=" + Uri.encode(code);
        message.setTextColor(color(R.color.muted));
        message.setText("Connecting…");
        check(address, (problem) -> {
            if (problem != null) {
                message.setTextColor(color(R.color.error));
                message.setText(problem);
                return;
            }
            host = address;
            prefs.edit().putString(KEY_HOST, address).apply();
            showWeb(pairPath);
        });
    }

    // The page didn't load: TV Guide isn't running, or the phone isn't on the same network.
    private void showOffline(String detail) {
        volumeKeys = false;
        LinearLayout layout = page();
        layout.addView(text("Can't reach TV Guide at " + host + ".", 18, R.color.text));
        layout.addView(text("Make sure the computer is on, TV Guide is running with phone access turned on, "
                + "and this phone is on the same Wi-Fi.", 16, R.color.text));
        if (detail != null) layout.addView(text(detail, 14, R.color.muted));
        Button retry = new Button(this);
        retry.setText("Try again");
        retry.setOnClickListener(v -> showWeb());
        layout.addView(retry);
        Button change = new Button(this);
        change.setText("Change address");
        change.setOnClickListener(v -> showSetup(null));
        layout.addView(change);
        show(layout);
    }

    private void showWeb() {
        showWeb("/");
    }

    private void showWeb(String path) {
        if (web == null) web = createWebView();
        show(web);
        web.loadUrl(baseUrl() + path);
    }

    private WebView createWebView() {
        // Debug builds: the page can be inspected from Chrome (chrome://inspect) over USB.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        WebView view = new WebView(this);
        view.setBackgroundColor(color(R.color.bg));
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // the page keeps the theme and last wish there
        // The pairing token is a cookie; keep it across restarts.
        CookieManager.getInstance().setAcceptCookie(true);
        view.addJavascriptInterface(new Bridge(), "TVGuideApp");
        view.setWebViewClient(new WebViewClient() {
            // Links to anywhere but the computer open in the browser.
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (Uri.parse(baseUrl()).getAuthority().equals(url.getAuthority())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, url));
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showOffline(String.valueOf(error.getDescription()));
            }
        });
        return view;
    }

    // --- Checking the address ---

    private interface CheckResult {
        void done(String problem);
    }

    // GET /api/hello on a background thread; reports a problem, or null if it's TV Guide.
    private void check(String address, CheckResult result) {
        new Thread(() -> {
            String problem = null;
            HttpURLConnection connection = null;
            try {
                String base = "http://" + (address.contains(":") ? address : address + ":" + PORT);
                connection = (HttpURLConnection) new URL(base + "/api/hello").openConnection();
                connection.setConnectTimeout(4000);
                connection.setReadTimeout(4000);
                try (InputStream in = connection.getInputStream()) {
                    ByteArrayOutputStream body = new ByteArrayOutputStream();
                    byte[] buffer = new byte[4096];
                    for (int n; (n = in.read(buffer)) > 0; ) body.write(buffer, 0, n);
                    JSONObject hello = new JSONObject(body.toString(StandardCharsets.UTF_8.name()));
                    if (!"tv-guide".equals(hello.optString("app"))) problem = "Something answered at " + address + ", but it isn't TV Guide.";
                }
            } catch (Exception e) {
                problem = "No answer from TV Guide at " + address + ". Is it running, with phone access turned on? "
                        + "If it is, the computer's firewall may be blocking port " + PORT + ". (" + e.getClass().getSimpleName() + ")";
            } finally {
                if (connection != null) connection.disconnect();
            }
            String finalProblem = problem;
            runOnUiThread(() -> result.done(finalProblem));
        }).start();
    }

    // --- What the page can ask of the app (window.TVGuideApp) ---

    private class Bridge {
        // The name the phone pairs as: the one set in Android's settings, else the model.
        @JavascriptInterface
        public String deviceName() {
            String name = Settings.Global.getString(getContentResolver(), Settings.Global.DEVICE_NAME);
            return name != null && !name.isEmpty() ? name : Build.MODEL;
        }

        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(() -> showSetup(null));
        }

        @JavascriptInterface
        public void setVolumeKeys(boolean enabled) {
            volumeKeys = enabled;
        }
    }

    // While VLC is open, the volume keys change VLC's volume instead of the phone's.
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int key = event.getKeyCode();
        if (volumeKeys && web != null && web.getParent() != null
                && (key == KeyEvent.KEYCODE_VOLUME_UP || key == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            if (event.getAction() == KeyEvent.ACTION_DOWN) {
                int direction = key == KeyEvent.KEYCODE_VOLUME_UP ? 1 : -1;
                web.evaluateJavascript("window.tvGuideVolumeStep && window.tvGuideVolumeStep(" + direction + ")", null);
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web != null && web.getParent() != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
        // The page sees it's hidden, and reconnects with fresh state when shown again.
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }
}

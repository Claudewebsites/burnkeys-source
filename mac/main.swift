// Burnkeys for macOS: a native window around the local Burnkeys engine.
// The engine (bundled Node.js + Burnkeys) runs on 127.0.0.1 only; this window
// shows its UI. It also keeps the saved keys in its own Keychain items for the engine.

import Cocoa
import Security
import WebKit


// Keys live in the app's own Keychain items (service "burnkeys.app"). The engine asks for them over a
// private pipe that only this process has: requests come in on its stderr, answers go to its stdin.
// Items made by the app trust only the app, so any other program gets a macOS permission prompt.
final class KeychainBridge {
    private let service = "burnkeys.app"
    private let toEngine = Pipe()
    private let fromEngine = Pipe()
    private var buffer = Data()

    func attach(_ p: Process) {
        var env = p.environment ?? [:]
        env["BURNKEYS_KEYCHAIN"] = "app"
        p.environment = env
        p.standardInput = toEngine
        p.standardError = fromEngine
        fromEngine.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            if data.isEmpty { h.readabilityHandler = nil; return } // engine exited
            self?.receive(data)
        }
    }

    private func receive(_ data: Data) {
        buffer.append(data)
        if buffer.count > 4_000_000 { buffer.removeAll() } // never a valid request
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            guard let text = String(data: line, encoding: .utf8) else { continue }
            if !text.hasPrefix("BKKC ") { continue } // other engine output is dropped: it is never written to logs
            guard
                  let json = text.dropFirst(5).data(using: .utf8),
                  let req = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
                  let id = req["id"] as? Int, let op = req["op"] as? String, let account = req["account"] as? String else { continue }
            var reply: [String: Any] = ["id": id, "ok": false]
            switch op {
            case "set": if let v = req["value"] as? String { reply["ok"] = set(account, v) }
            case "get": if let v = get(account) { reply["ok"] = true; reply["value"] = v }
            case "delete": reply["ok"] = delete(account)
            default: break
            }
            if let out = try? JSONSerialization.data(withJSONObject: reply) {
                try? toEngine.fileHandleForWriting.write(contentsOf: out + Data([0x0A]))
            }
        }
    }

    private func base(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    private func set(_ account: String, _ value: String) -> Bool {
        // Update in place, so a failure never loses the key that was there.
        let upd = SecItemUpdate(base(account) as CFDictionary, [kSecValueData as String: Data(value.utf8)] as CFDictionary)
        if upd == errSecSuccess { return true }
        if upd != errSecItemNotFound { return false }
        var q = base(account)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrLabel as String] = "Burnkeys key"
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }
    private func get(_ account: String) -> String? {
        var q = base(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
    private func delete(_ account: String) -> Bool {
        let st = SecItemDelete(base(account) as CFDictionary)
        return st == errSecSuccess || st == errSecItemNotFound
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    let keychain = KeychainBridge()
    var engine: Process?
    var engineURL: URL?

    // burnkeys://auth?state=...&token=... arrives after signing in on burnkeys.com.
    func application(_ application: NSApplication, open urls: [URL]) {
        // burnkeys://open?view=alerts from burnkeys.com: bring the window forward on that view.
        for url in urls where url.scheme == "burnkeys" && url.host == "open" && engineURL != nil {
            let view = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "view" })?.value ?? "overview"
            let safe = ["overview", "alerts", "platforms", "providers", "projects"].contains(view) ? view : "overview"
            window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            webView?.evaluateJavaScript("window.burnkeysGo && window.burnkeysGo('\(safe)')")
        }
        for url in urls where url.scheme == "burnkeys" && url.host == "auth" {
            guard let base = engineURL, let fragment = base.fragment,
                  let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
                  let st = items.first(where: { $0.name == "state" })?.value,
                  let tk = items.first(where: { $0.name == "token" })?.value,
                  var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) else { continue }
            comps.fragment = nil
            comps.path = "/api/account/link"
            guard let linkURL = comps.url else { continue }
            var req = URLRequest(url: linkURL)
            req.httpMethod = "POST"
            req.setValue(fragment, forHTTPHeaderField: "x-burnkeys-token")
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["state": st, "token": tk])
            URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in
                DispatchQueue.main.async {
                    self?.window.makeKeyAndOrderFront(nil)
                    NSApp.activate(ignoringOtherApps: true)
                    self?.webView.evaluateJavaScript("window.burnkeysSignedIn && window.burnkeysSignedIn()")
                }
            }.resume()
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "burnkeys")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 720),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Burnkeys"
        window.minSize = NSSize(width: 760, height: 480)
        // Modern, unified look (like Claude): no grey title bar, the app's own dark header runs to the top.
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = false
        applyTheme("dark")
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("BurnkeysMain")
        window.makeKeyAndOrderFront(nil)

        showMessage("Starting Burnkeys…")
        startEngine()
    }

    // Start the bundled engine and load its UI once it prints its local address.
    func startEngine() {
        guard let res = Bundle.main.resourceURL else { return }
        let process = Process()
        process.executableURL = res.appendingPathComponent("node/bin/node")
        process.arguments = [res.appendingPathComponent("engine/bin/burnkeys.js").path, "app", "--no-open"]
        process.environment = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        let out = Pipe()
        process.standardOutput = out
        keychain.attach(process)
        var loaded = false
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let text = String(decoding: handle.availableData, as: UTF8.self)
            guard !loaded, let range = text.range(of: #"http://127\.0\.0\.1:[0-9]+/#[0-9a-f]+"#, options: .regularExpression),
                  let url = URL(string: String(text[range])) else { return }
            loaded = true
            DispatchQueue.main.async {
                self?.engineURL = url
                self?.webView.load(URLRequest(url: url))
            }
        }
        process.terminationHandler = { [weak self] p in
            DispatchQueue.main.async {
                if NSApp.isRunning, p.terminationReason == .uncaughtSignal || p.terminationStatus != 0 {
                    self?.showMessage("Burnkeys stopped unexpectedly. Quit and open it again.")
                }
            }
        }
        do {
            try process.run()
            engine = process
        } catch {
            showMessage("Couldn't start Burnkeys: \(error.localizedDescription)")
        }
    }

    func showMessage(_ text: String) {
        let safe = text.replacingOccurrences(of: "<", with: "&lt;")
        webView.loadHTMLString("""
        <html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
        font:15px -apple-system;color:#8E8378;background:transparent">\(safe)</body></html>
        """, baseURL: nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        engine?.terminate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // Links to other sites (provider key pages, X, ...) open in the default browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.scheme == "x-apple.systempreferences" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        if let url = action.request.url, let scheme = url.scheme, scheme.hasPrefix("http"), url.host != "127.0.0.1" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // window.open(...) from the page: open in the default browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // <input type=file> in the page (a .p8 or service-account .json): the native file picker.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    // Keep the window frame in step with the app's theme.
    func applyTheme(_ theme: String) {
        let dark = theme == "dark" || (theme == "auto" && NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua)
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.backgroundColor = dark ? NSColor(red: 0.086, green: 0.067, blue: 0.055, alpha: 1) : NSColor.white
    }

    // The page asks for a folder: show the native folder picker.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if let body = message.body as? String, body.hasPrefix("theme:") {
            applyTheme(String(body.dropFirst(6)))
            return
        }
        guard let kind = message.body as? String, kind == "pickFolder" || kind == "pickProjectFolder" else { return }
        let forProject = kind == "pickProjectFolder"
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        panel.canCreateDirectories = forProject
        panel.message = forProject ? "Choose where to create the new project" : "Choose the folder that holds your projects"
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let path = panel.url?.path,
                  let json = try? JSONSerialization.data(withJSONObject: [path]),
                  let arg = String(data: json, encoding: .utf8) else { return }
            let fn = forProject ? "burnkeysPickedProjectFolder" : "burnkeysPickedFolder"
            self?.webView.evaluateJavaScript("window.\(fn) && window.\(fn)(\(arg)[0])")
        }
    }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Burnkeys", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Burnkeys", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Burnkeys", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        viewItem.submenu = view

        let windowItem = NSMenuItem(); main.addItem(windowItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = win
        NSApp.windowsMenu = win

        NSApp.mainMenu = main
    }

    @objc func reload() { webView.reload() }
}

// Started by the background LaunchAgent (Pro): run one check round without a window, then quit.
// Running as the app (not a bare script) keeps the folder access the user granted to Burnkeys.
if CommandLine.arguments.contains("--background") {
    if let res = Bundle.main.resourceURL {
        let p = Process()
        p.executableURL = res.appendingPathComponent("node/bin/node")
        p.arguments = [res.appendingPathComponent("engine/bin/burnkeys.js").path, "agent"]
        p.environment = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        p.standardOutput = FileHandle.nullDevice
        let bridge = KeychainBridge()
        bridge.attach(p)
        try? p.run()
        // Keep the main thread free so the bridge can answer while the check runs.
        while p.isRunning { RunLoop.current.run(until: Date().addingTimeInterval(0.2)) }
    }
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)
app.run()

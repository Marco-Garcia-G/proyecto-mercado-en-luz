import UIKit
import WebKit

@MainActor private final class WeakBridgeHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var owner: MainViewController?

    init(owner: MainViewController) { self.owner = owner }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        owner?.userContentController(userContentController, didReceive: message, replyHandler: replyHandler)
    }
}

@MainActor final class MainViewController: UIViewController, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
    private var webView: WKWebView!

    override func loadView() {
        let content = WKUserContentController()
        content.addScriptMessageHandler(WeakBridgeHandler(owner: self), contentWorld: .page, name: "iosBridge")
        let platform = UIDevice.current.userInterfaceIdiom == .pad ? "platform-ipad" : "platform-iphone"
        content.addUserScript(WKUserScript(
            source: "document.documentElement.classList.add('platform-apple', '\(platform)');",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = content
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.backgroundColor = UIColor(red: 7 / 255, green: 9 / 255, blue: 11 / 255, alpha: 1)
        webView.isOpaque = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.navigationDelegate = self
        if UIDevice.current.userInterfaceIdiom == .pad {
            let container = UIView()
            container.backgroundColor = webView.backgroundColor
            let toolbar = UIView()
            toolbar.backgroundColor = UIColor(red: 10 / 255, green: 15 / 255, blue: 14 / 255, alpha: 1)

            let title = UILabel()
            title.text = "MercadoEnLuz"
            title.textColor = .white
            title.font = .systemFont(ofSize: 15, weight: .bold)
            title.accessibilityTraits = .header

            var configuration: UIButton.Configuration
            if #available(iOS 26.0, *) {
                configuration = .glass()
            } else {
                configuration = .tinted()
            }
            let english = Bundle.main.preferredLocalizations.first?.lowercased().hasPrefix("en") == true
            configuration.title = english ? "Portfolio" : "Cartera"
            configuration.image = UIImage(systemName: "chart.line.uptrend.xyaxis")
            configuration.imagePadding = 8
            configuration.baseForegroundColor = .white
            let button = UIButton(configuration: configuration)
            button.accessibilityLabel = english ? "Go to portfolio" : "Ir a la cartera"
            button.addTarget(self, action: #selector(showPortfolio), for: .touchUpInside)

            [toolbar, webView].forEach { container.addSubview($0) }
            [title, button].forEach { toolbar.addSubview($0) }
            [toolbar, webView, title, button].forEach { $0.translatesAutoresizingMaskIntoConstraints = false }
            NSLayoutConstraint.activate([
                toolbar.topAnchor.constraint(equalTo: container.topAnchor),
                toolbar.leadingAnchor.constraint(equalTo: container.leadingAnchor),
                toolbar.trailingAnchor.constraint(equalTo: container.trailingAnchor),
                toolbar.bottomAnchor.constraint(equalTo: container.safeAreaLayoutGuide.topAnchor, constant: 64),
                title.leadingAnchor.constraint(equalTo: toolbar.safeAreaLayoutGuide.leadingAnchor, constant: 28),
                title.bottomAnchor.constraint(equalTo: toolbar.bottomAnchor, constant: -15),
                button.trailingAnchor.constraint(equalTo: toolbar.safeAreaLayoutGuide.trailingAnchor, constant: -24),
                button.centerYAnchor.constraint(equalTo: title.centerYAnchor),
                webView.topAnchor.constraint(equalTo: toolbar.bottomAnchor),
                webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
                webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
                webView.bottomAnchor.constraint(equalTo: container.bottomAnchor)
            ])
            view = container
        } else {
            view = webView
        }
    }

    @objc private func showPortfolio() {
        webView.evaluateJavaScript("document.getElementById('mercado')?.scrollIntoView({behavior: 'smooth'});")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let english = Bundle.main.preferredLocalizations.first?.lowercased().hasPrefix("en") == true
        let directory = english ? "web/en" : "web"
        guard let page = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: directory) else {
            assertionFailure("Faltan los archivos de la interfaz web")
            return
        }
        webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.name == "iosBridge", let request = message.body as? [String: String],
              let url = request["url"], url.hasPrefix("/api/") else {
            replyHandler(nil, "Solicitud local no válida")
            return
        }
        Task { @MainActor in
            let result = await LocalAPI.shared.handle(method: request["method"] ?? "GET",
                address: url, body: request["body"] ?? "")
            replyHandler(result, nil)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        decisionHandler(url.isFileURL || url.scheme == "about" ? .allow : .cancel)
    }

}

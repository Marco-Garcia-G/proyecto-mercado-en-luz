import BackgroundTasks
import UIKit

private final class BackgroundCompletion {
    private let lock = NSLock()
    private var finished = false
    private let task: BGTask

    init(_ task: BGTask) { self.task = task }

    func finish(success: Bool) {
        lock.lock()
        let shouldFinish = !finished
        finished = true
        lock.unlock()
        if shouldFinish { task.setTaskCompleted(success: success) }
    }
}

@main final class AppDelegate: UIResponder, UIApplicationDelegate {
    private let refreshIdentifier = "com.mercadoenluz.app.refresh"
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: refreshIdentifier, using: nil) { task in
            guard let task = task as? BGAppRefreshTask else { return }
            self.handleRefresh(task)
        }
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = MainViewController()
        window?.makeKeyAndVisible()
        Task { @MainActor in LocalAPI.shared.start() }
        scheduleRefresh()
        return true
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        Task { @MainActor in LocalAPI.shared.setForeground(false) }
        scheduleRefresh()
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        Task { @MainActor in
            LocalAPI.shared.setForeground(true)
            await LocalAPI.shared.refresh()
        }
    }

    private func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private func handleRefresh(_ task: BGAppRefreshTask) {
        scheduleRefresh()
        let completion = BackgroundCompletion(task)
        let operation = Task { @MainActor in
            await LocalAPI.shared.refresh()
            completion.finish(success: !Task.isCancelled)
        }
        task.expirationHandler = {
            operation.cancel()
            completion.finish(success: false)
        }
    }
}

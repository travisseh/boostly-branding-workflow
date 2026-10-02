// Browser calls must run inside a live REPL invocation. Discovery can wait
// between invocations while the queue retains the next read-only browser step.
export function createDeferredBrowserAgent(actual) {
  const queue = [];
  const enqueue = run => new Promise((resolve, reject) => queue.push({ run, resolve, reject }));
  const wrapTab = tab => ({
    goto: (...args) => enqueue(() => tab.goto(...args)),
    url: (...args) => enqueue(() => tab.url(...args)),
    playwright: {
      evaluate: (...args) => enqueue(() => tab.playwright.evaluate(...args)),
      waitForLoadState: (...args) => enqueue(() => tab.playwright.waitForLoadState(...args)),
      waitForTimeout: (...args) => enqueue(() => tab.playwright.waitForTimeout(...args)),
    },
  });
  const wrapBrowser = browser => ({
    nameSession: (...args) => enqueue(() => browser.nameSession(...args)),
    tabs: { new: (...args) => enqueue(async () => wrapTab(await browser.tabs.new(...args))) },
  });
  return {
    agent: {
      browsers: {
        list: () => enqueue(() => actual.browsers.list()),
        get: id => enqueue(async () => wrapBrowser(await actual.browsers.get(id))),
      },
    },
    async pump(isDone, budgetMs = 45000) {
      if (typeof isDone !== "function" || !Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error("Invalid pump boundary");
      const end = Date.now() + budgetMs;
      let operations = 0;
      while (!isDone() && Date.now() < end) {
        const next = queue.shift();
        if (!next) {
          await new Promise(resolve => setTimeout(resolve, 20));
          continue;
        }
        try { next.resolve(await next.run()); }
        catch (error) { next.reject(error); }
        operations++;
      }
      return { operations, pending: queue.length, done: Boolean(isDone()) };
    },
  };
}

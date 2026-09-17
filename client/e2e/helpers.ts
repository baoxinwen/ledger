// e2e 共享工具：各 spec 文件的登录初始化逻辑收敛于此，避免复制漂移。
import type { Page } from '@playwright/test';

export const E2E_SETUP_TOKEN = 'e2e-setup-token';
export const E2E_USERNAME = 'admin';
export const E2E_PASSWORD = 'e2e-password';

// 确保当前浏览器上下文已登录：首次运行用初始化 Token 创建账户，之后用固定凭据登录。
// 并行 worker 下多个用例可能同时初始化：后端对已初始化账户的 setup 请求返回 409，
// 因此 setup 失败必须回退到登录路径并重试，否则用例会在未登录状态下继续执行而失败。
async function ensureAuthenticated(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const me = (await (await page.request.get('/api/auth/me')).json()) as {
      authenticated: boolean;
      needsSetup: boolean;
    };
    if (me.authenticated) return;

    if (me.needsSetup) {
      const setupResponse = await page.request.post('/api/auth/setup', {
        data: { token: E2E_SETUP_TOKEN, username: E2E_USERNAME, password: E2E_PASSWORD },
      });
      if (setupResponse.ok()) return;
    }
    const loginResponse = await page.request.post('/api/auth/login', {
      data: { username: E2E_USERNAME, password: E2E_PASSWORD },
    });
    if (loginResponse.ok()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('e2e 初始化/登录失败：请确认后端可访问');
}

export { ensureAuthenticated };

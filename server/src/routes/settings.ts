// 设置路由：提供应用级偏好配置，目前包含全局业务时区。
import { Router, Request, Response } from 'express';
import { settingsService } from '../services/settings.service';
import { getErrorMessage, isInternalSystemError } from '../utils/errors';
import { logger } from '../utils/logger';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json(settingsService.getSettings());
});

router.put('/', (req: Request, res: Response) => {
  try {
    res.json(settingsService.updateSettings({
      time_zone: req.body.time_zone,
      theme_mode: req.body.theme_mode,
    }));
  } catch (error) {
    // 与 importExport 路由同一错误分类：校验类错误保留可操作文案，
    // 系统级错误（SQLite/文件系统）按 500 + 通用文案响应，不泄露内部信息。
    if (isInternalSystemError(error)) {
      logger.error('保存设置失败（系统错误）', { scope: 'settings', error: getErrorMessage(error) });
      res.status(500).json({ error: '服务器内部错误' });
      return;
    }
    res.status(400).json({
      error: getErrorMessage(error) || '保存设置失败',
    });
  }
});

export default router;

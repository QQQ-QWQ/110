import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './core/exception.filter';
import { accessLogMiddleware, requestIdMiddleware } from './core/request-id';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  // 所有接口统一挂在 /api 下，便于 Nginx 反代
  app.setGlobalPrefix('api');

  // 请求编号 + 访问日志：**越早注册越好**，之后产生的每一行日志都会带上 rid。
  // 放在 helmet 之前，连 helmet 自身抛出的异常也能被关联到同一次请求。
  // 详见 core/request-id.ts（报告 §5.2 S5）。
  app.use(requestIdMiddleware);
  app.use(accessLogMiddleware);

  app.use(
    helmet({
      // API 只返回 JSON，不需要 CSP；关闭以免误伤同源前端资源
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // 统一错误出口：失败绝不会被渲染成成功
  app.useGlobalFilters(new AllExceptionsFilter());

  // 生产由 Nginx 同源反代，无需 CORS；仅开发期按需开启
  const corsOrigin = process.env.CORS_ORIGIN;
  if (corsOrigin && corsOrigin.trim().length > 0) {
    app.enableCors({
      origin: corsOrigin.split(',').map((s) => s.trim()),
      credentials: true,
    });
  }

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`后端已启动：http://0.0.0.0:${port}/api`);
}

void bootstrap();

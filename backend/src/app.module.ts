import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreModule } from './core/core.module';
import { HealthController } from './health.controller';
import { AuthModule } from './modules/auth/auth.module';
import { RequirementsModule } from './modules/requirements/requirements.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { SubmissionsModule } from './modules/submissions/submissions.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CoreModule,
    AuthModule,
    RequirementsModule,
    SubmissionsModule,
    ReviewsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

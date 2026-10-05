import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import {
  Body,
  Controller,
  Headers,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { idempotencyKeyOf, parseVersionHeader } from '../../core/http';
import { AuthGuard, CurrentUser } from '../../core/security/auth.guard';
import { ResolvedSession } from '../../core/security/session.service';
import { ReviewsService } from './reviews.service';

export class ReviewCheckDto {
  @IsString()
  @IsNotEmpty()
  criterionId!: string;

  @IsBoolean()
  passed!: boolean;
}

export class ReviewDto {
  @IsIn(['RETURN', 'COMPLETE'], { message: '验收动作不合法' })
  action!: 'RETURN' | 'COMPLETE';

  @IsOptional()
  @IsString()
  reason?: string;

  @IsArray()
  @ArrayMinSize(1, { message: '请逐项记录验收结果' })
  @ValidateNested({ each: true })
  @Type(() => ReviewCheckDto)
  checks!: ReviewCheckDto[];
}

@Controller('submissions/:submissionId/reviews')
@UseGuards(AuthGuard)
export class ReviewsController {
  constructor(private readonly service: ReviewsService) {}

  @Post()
  async review(
    @CurrentUser() user: ResolvedSession,
    @Param('submissionId') submissionId: string,
    @Body() dto: ReviewDto,
    @Headers('if-match') ifMatch?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.review(user.userId, submissionId, dto, {
      expectedRowVersion: parseVersionHeader(ifMatch),
      idempotencyKey: idempotencyKeyOf(idempotencyKey),
    });
  }
}

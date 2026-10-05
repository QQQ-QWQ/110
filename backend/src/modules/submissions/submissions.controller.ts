import { ArrayMinSize, IsArray, IsNotEmpty, IsString } from 'class-validator';
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { idempotencyKeyOf, parseVersionHeader } from '../../core/http';
import { AuthGuard, CurrentUser } from '../../core/security/auth.guard';
import { ResolvedSession } from '../../core/security/session.service';
import { SubmissionsService } from './submissions.service';

export class SubmitDto {
  @IsArray()
  @ArrayMinSize(1, { message: '至少填写一个可查看的成果链接' })
  @IsString({ each: true })
  artifacts!: string[];

  @IsString()
  @IsNotEmpty({ message: '请填写完成说明' })
  note!: string;
}

@Controller('requirements/:requirementId/submissions')
@UseGuards(AuthGuard)
export class SubmissionsController {
  constructor(private readonly service: SubmissionsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async submit(
    @CurrentUser() user: ResolvedSession,
    @Param('requirementId') requirementId: string,
    @Body() dto: SubmitDto,
    @Headers('if-match') ifMatch?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.submit(user.userId, requirementId, dto, {
      expectedRowVersion: parseVersionHeader(ifMatch),
      idempotencyKey: idempotencyKeyOf(idempotencyKey),
    });
  }
}

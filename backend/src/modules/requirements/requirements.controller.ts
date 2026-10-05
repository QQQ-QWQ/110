import { ArrayMinSize, IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Errors } from '../../core/errors';
import { idempotencyKeyOf, parseVersionHeader } from '../../core/http';
import { AuthGuard, CurrentUser } from '../../core/security/auth.guard';
import { ResolvedSession } from '../../core/security/session.service';
import { ALL_STATES, RequirementState } from '../../domain/states';
import { RequirementsService } from './requirements.service';

export class CreateRequirementDto {
  @IsString()
  @IsNotEmpty({ message: '请填写标题' })
  title!: string;

  @IsString()
  @IsNotEmpty({ message: '请填写问题与内容说明' })
  description!: string;

  @IsString()
  @IsNotEmpty({ message: '请指定负责人' })
  assigneeId!: string;

  @IsArray()
  @ArrayMinSize(1, { message: '至少需要一条可核对的验收条件' })
  @IsString({ each: true })
  criteria!: string[];
}

export class EditRequirementDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  criteria?: string[];
}

@Controller('requirements')
@UseGuards(AuthGuard)
export class RequirementsController {
  constructor(private readonly service: RequirementsService) {}

  @Get()
  async list(
    @CurrentUser() user: ResolvedSession,
    @Query('state') state?: string,
    @Query('scope') scope?: string,
    @Query('keyword') keyword?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    if (state && !(ALL_STATES as readonly string[]).includes(state)) {
      throw Errors.validation('状态筛选值不合法');
    }
    const normalizedScope = scope === 'proposed' || scope === 'assigned' ? scope : ('all' as const);
    return this.service.list(
      user.userId,
      {
        state: state as RequirementState | undefined,
        scope: normalizedScope,
        keyword,
      },
      // limit / cursor 的校验与解码放在 service 内（与其余筛选值一致）：
      // 控制器只做「状态枚举」这一处必须早于服务层的检查。
      { limit, cursor },
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: ResolvedSession,
    @Body() dto: CreateRequirementDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.create(user.userId, dto, {
      idempotencyKey: idempotencyKeyOf(idempotencyKey),
    });
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: ResolvedSession,
    @Param('id') id: string,
    // 只对事件时间线开放：submissions 用固定上界（见 pagination.ts 的说明），
    // 因为它的数量由「重提次数」决定，不像事件那样随活动线性增长。
    @Query('eventsLimit') eventsLimit?: string,
  ) {
    return this.service.detail(user.userId, id, { eventsLimit });
  }

  @Get(':id/history')
  async history(
    @CurrentUser() user: ResolvedSession,
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.history(user.userId, id, { limit, cursor });
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async edit(
    @CurrentUser() user: ResolvedSession,
    @Param('id') id: string,
    @Body() dto: EditRequirementDto,
    @Headers('if-match') ifMatch?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.edit(user.userId, id, dto, {
      expectedRowVersion: parseVersionHeader(ifMatch),
      idempotencyKey: idempotencyKeyOf(idempotencyKey),
    });
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  async start(
    @CurrentUser() user: ResolvedSession,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.start(user.userId, id, {
      expectedRowVersion: parseVersionHeader(ifMatch),
      idempotencyKey: idempotencyKeyOf(idempotencyKey),
    });
  }
}

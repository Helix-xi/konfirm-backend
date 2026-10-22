import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { TeamService } from './team.service';
import { MAILER, mailerFromEnv } from '../mail/mailer';

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, TeamService, { provide: MAILER, useFactory: () => mailerFromEnv() }],
  exports: [AuthService, AuthGuard, TeamService],
})
export class AuthModule {}

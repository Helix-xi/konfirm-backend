import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../admin-auth/admin-auth.guard';
import { AdminClaims } from '../admin-auth/admin-auth.service';
import { CurrentAdmin } from '../admin-auth/current-admin.decorator';
import { AdminService } from './admin.service';
import { CreateAdminDto } from './dto/create-admin.dto';

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('admins')
  async listAdmins(@CurrentAdmin() admin: AdminClaims) {
    this.assertSuperadmin(admin);
    return this.adminService.listAdmins();
  }

  @Post('admins')
  async createAdmin(
    @CurrentAdmin() admin: AdminClaims,
    @Body() dto: CreateAdminDto,
  ) {
    this.assertSuperadmin(admin);
    return this.adminService.createAdmin(dto);
  }

  @Delete('admins/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deactivateAdmin(
    @CurrentAdmin() admin: AdminClaims,
    @Param('id') id: string,
  ) {
    this.assertSuperadmin(admin);
    await this.adminService.deactivateAdmin(id, admin.id);
  }

  private assertSuperadmin(admin: AdminClaims): void {
    if (admin.role !== 'superadmin') {
      throw new ForbiddenException('Requires superadmin role');
    }
  }
}

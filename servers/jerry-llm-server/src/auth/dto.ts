import { IsString, IsOptional, MinLength, MaxLength, IsEmail, Matches } from 'class-validator';

export class RegisterDto {
  @IsOptional()
  @IsEmail({}, { message: '邮箱格式不正确' })
  email?: string;

  @IsOptional()
  @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
  phone?: string;

  @IsString()
  @MinLength(6, { message: '密码长度至少6位' })
  @MaxLength(128, { message: '密码长度不能超过128位' })
  password: string;

  @IsOptional()
  @IsString()
  @MinLength(2, { message: '用户名长度应在2-20位之间' })
  @MaxLength(20, { message: '用户名长度应在2-20位之间' })
  username?: string;
}

export class LoginDto {
  @IsString()
  account: string;

  @IsString()
  password: string;
}

export class ChangePasswordDto {
  @IsString()
  oldPassword: string;

  @IsString()
  @MinLength(6, { message: '新密码长度至少6位' })
  @MaxLength(128, { message: '密码长度不能超过128位' })
  newPassword: string;
}

export class ResetPasswordDto {
  @IsString()
  account: string;

  @IsString()
  @MinLength(6, { message: '新密码长度至少6位' })
  @MaxLength(128, { message: '密码长度不能超过128位' })
  newPassword: string;
}

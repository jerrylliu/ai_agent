// 导入 NestJS 测试模块中的 Test 和 TestingModule
import { Test, TestingModule } from '@nestjs/testing';
// 导入应用控制器
import { AppController } from './app.controller';
// 导入应用服务
import { AppService } from './app.service';

// 定义 AppController 的测试套件
describe('AppController', () => {
  // 声明应用控制器变量
  let appController: AppController;

  // 在每个测试用例执行前运行的钩子函数
  beforeEach(async () => {
    // 创建测试模块
    const app: TestingModule = await Test.createTestingModule({
      // 注册控制器
      controllers: [AppController],
      // 注册服务提供者
      providers: [AppService],
    }).compile();

    // 从测试模块中获取 AppController 实例
    appController = app.get<AppController>(AppController);
  });

  // 定义 root 方法的测试套件
  describe('root', () => {
    // 测试用例：验证 getHello 方法返回 "Hello World!"
    it('should return "Hello World!"', () => {
      // 断言 getHello 方法的返回值等于 "Hello World!"
      expect(appController.getHello()).toBe('Hello World!');
    });
  });
});

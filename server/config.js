// 全局配置：连接对话框的表单默认值（不会在启动/登录时自动连接）
module.exports = {
  port: process.env.PORT || 3000,
  defaultConnection: {
    name: '本机 MySQL',
    type: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: ''
  }
};

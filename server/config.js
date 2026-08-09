// 全局配置：默认 MySQL 连接信息（用于本机快速连接）
module.exports = {
  port: process.env.PORT || 3000,
  // 默认连接（本机 root 无密码），前端首次打开可直接使用
  defaultConnection: {
    name: '本机 MySQL',
    type: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database: ''
  }
};

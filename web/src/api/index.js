import axios from 'axios';

const http = axios.create({ baseURL: '/api', timeout: 60000 });

// 初始化 token
const _initToken = () => {
  const t = localStorage.getItem('navcove_token');
  if (t) http.defaults.headers.common['Authorization'] = 'Bearer ' + t;
};
_initToken();

http.interceptors.response.use(
  (res) => {
    const body = res.data;
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code === 0) return body.data;
      return Promise.reject(new Error(body.message || '请求失败'));
    }
    return body;
  },
  (err) => {
    const msg = (err.response && err.response.data && err.response.data.message) || err.message || '网络错误';
    return Promise.reject(new Error(msg));
  }
);

export const api = {
  // 认证
  login: (username, password) => http.post('/auth/login', { username, password }).then((data) => {
    if (data.token) {
      localStorage.setItem('navcove_token', data.token);
      http.defaults.headers.common['Authorization'] = 'Bearer ' + data.token;
    }
    return data;
  }),
  logout: () => {
    const token = localStorage.getItem('navcove_token');
    localStorage.removeItem('navcove_token');
    delete http.defaults.headers.common['Authorization'];
    return http.post('/auth/logout', { token });
  },
  me: () => http.get('/auth/me'),
  // 连接
  getDefaultConnection: () => http.get('/connection/default'),
  getConnection: (id) => http.get(`/connection/${id}`),
  testConnection: (conn) => http.post('/connection/test', conn),
  connect: (conn) => http.post('/connection/connect', conn),
  disconnect: (id) => http.delete(`/connection/${id}`),
  listConnections: () => http.get('/connection'),
  // 库/表
  listDatabases: (connId) => http.get('/databases', { params: { connId } }),
  listTables: (connId, database) => http.get('/tables', { params: { connId, database } }),
  tableColumns: (connId, database, table) => http.get('/table/columns', { params: { connId, database, table } }),
  tableData: (connId, database, table, params) => http.get('/table/data', { params: { connId, database, table, ...params } }),
  saveTable: (connId, database, table, changes) => http.post('/table/save', { connId, database, table, changes }),
  // 单行操作（按主键）
  updateRow: (connId, database, table, pk, values) =>
    http.put('/table/row', { connId, database, table, pk, values }),
  insertRow: (connId, database, table, values) =>
    http.post('/table/row', { connId, database, table, values }),
  deleteRow: (connId, database, table, pk) =>
    http.delete('/table/row', { data: { connId, database, table, pk } }),
  // 表结构操作（DDL）
  createTable: (connId, database, table, columns) =>
    http.post('/table/create', { connId, database, table, columns }),
  dropTable: (connId, database, table) =>
    http.delete('/table', { data: { connId, database, table } }),
  truncateTable: (connId, database, table) =>
    http.post('/table/truncate', { connId, database, table }),
  copyTable: (connId, database, srcTable, destTable) =>
    http.post('/table/copy', { connId, database, srcTable, destTable }),
  renameTable: (connId, database, oldName, newName) =>
    http.post('/table/rename', { connId, database, oldName, newName }),
  // 数据库操作（DDL）
  createDatabase: (connId, name, charset) =>
    http.post('/database/create', { connId, name, charset }),
  dropDatabase: (connId, name) =>
    http.delete('/database', { data: { connId, name } }),
  alterDatabase: (connId, name, charset) =>
    http.post('/database/alter', { connId, name, charset }),
  getDatabaseInfo: (connId, name) =>
    http.get('/database/info', { params: { connId, name } }),
  // 查看结构
  getDatabaseStructure: (connId, database) =>
    http.get('/database/structure', { params: { connId, database } }),
  getTableStructure: (connId, database, table) =>
    http.get('/table/structure', { params: { connId, database, table } }),
  // 查询
  query: (connId, database, sql) => http.post('/query', { connId, database, sql }),
  // 导入导出
  exportTableUrl: (connId, database, table, limit) =>
    `/api/export/table?connId=${encodeURIComponent(connId)}&database=${encodeURIComponent(database)}&table=${encodeURIComponent(table)}${limit ? `&limit=${limit}` : ''}`,
  exportQueryCsv: (connId, database, sql) =>
    http.post('/export/query', { connId, database, sql }, { responseType: 'blob' }),
  exportQuerySql: (connId, database, sql, table) =>
    http.post('/export/query/sql', { connId, database, sql, table }, { responseType: 'blob' }),
  // SQL 导出（结构 + 数据可分别勾选）
  exportSqlTableUrl: (connId, database, table, opts = {}) => {
    const base = `/api/export/sql/table?connId=${encodeURIComponent(connId)}&database=${encodeURIComponent(database)}&table=${encodeURIComponent(table)}`;
    const qs = new URLSearchParams();
    if (opts.withSchema === false) qs.append('withSchema', '0');
    if (opts.withData === false) qs.append('withData', '0');
    if (opts.limit && opts.limit > 0) qs.append('limit', String(opts.limit));
    const q = qs.toString();
    return base + (q ? `&${q}` : '');
  },
  exportSqlDatabaseUrl: (connId, database, opts = {}) => {
    const base = `/api/export/sql/database?connId=${encodeURIComponent(connId)}&database=${encodeURIComponent(database)}`;
    const qs = new URLSearchParams();
    if (opts.withSchema === false) qs.append('withSchema', '0');
    if (opts.withData === false) qs.append('withData', '0');
    if (opts.limit && opts.limit > 0) qs.append('limit', String(opts.limit));
    const q = qs.toString();
    return base + (q ? `&${q}` : '');
  },
  importTable: (connId, database, table, content, replace) =>
    http.post('/import/table', { connId, database, table, content, replace }),

  // 切片上传导入（断点续传）
  importInit: (payload) => http.post('/import/upload/init', payload),
  // 切片上传使用 FormData（multipart/form-data）：Content-Type 交给浏览器自动生成（带 boundary）
  importChunk: (formData) => http.post('/import/upload/chunk', formData),
  importMerge: (payload) => http.post('/import/upload/merge', payload, { timeout: 300000 }),
  importCancel: (uploadId) => http.delete(`/import/upload/${uploadId}`)
};

export default api;


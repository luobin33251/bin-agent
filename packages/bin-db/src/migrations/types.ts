// 迁移的定义结构
export interface Migration {
  name: string;
  sql: string;
}
# StockHub 云端 Storage 安全加固

> 原文件为 `.sql`，但发布平台会拦截 `.sql` 后缀导致「源码下载」中缺失，
> 因此改用 Markdown 文档形式交付。请直接复制下方 SQL 代码块，在 Supabase SQL Editor 中全选执行。

## 作用

当前应用数据存于 Supabase Storage 桶（默认 `workbench-data`），4 个固定文件：

- `data.json`（工作数据）
- `base.json`（基准底账）
- `settings.json`（用户偏好）
- `stocktake.json`（盘点数据）

应用通过 `anon` key 访问，没有 Supabase Auth 登录。因此没有表级 RLS，
只能通过 **Storage 对象策略** 做权限控制。

本脚本将桶设为**私有**，并给 `anon` 角色按精确文件名白名单授权读写，
达到「关闭公开拖库 + 纵深防御」的效果。

## 执行说明

1. 打开 Supabase 控制台 → SQL Editor。
2. 全选复制下方 SQL 代码块。
3. 粘贴后点击 **Run**。
4. 检查输出中的策略列表，确认 4 条 `anon_*_workbench_data` 策略存在。

```sql
-- ============================================================
-- StockHub 云端 Storage 安全加固
-- 适用：数据存于 Supabase Storage 桶（默认 workbench-data），
--       通过 anon key 访问，无 Supabase Auth 登录。
-- 作用：① 关闭桶的「公开访问」；② 用 Storage 对象策略(RLS)把 anon 角色
--       限定在「本桶 + 4 个已知文件名」，禁止读写其它桶/路径。
-- 幂等：先 drop 再 create，可重复执行。
-- ============================================================

-- ① 将桶设为私有（关闭公开 URL 直接访问）。
update storage.buckets
   set public = false
 where id = 'workbench-data';

-- ② 开启 storage.objects 的 RLS（默认即开，这里显式确保）。
alter table storage.objects enable row level security;

-- 精确文件白名单（与代码保持一致：data.json / base.json / settings.json / stocktake.json）
do $$
declare
  b text := 'workbench-data';
  names text[] := array['data.json','base.json','settings.json','stocktake.json'];
begin
  -- 先清理旧策略，保证可重复执行
  drop policy if exists "anon_select_workbench_data"  on storage.objects;
  drop policy if exists "anon_insert_workbench_data"  on storage.objects;
  drop policy if exists "anon_update_workbench_data"  on storage.objects;
  drop policy if exists "anon_delete_workbench_data"  on storage.objects;

  -- 读：list / download 均走 SELECT
  create policy "anon_select_workbench_data" on storage.objects
    for select to anon
    using ( bucket_id = b and name = any(names) );

  -- 写：upload(upsert) 触发 INSERT / UPDATE
  create policy "anon_insert_workbench_data" on storage.objects
    for insert to anon
    with check ( bucket_id = b and name = any(names) );

  create policy "anon_update_workbench_data" on storage.objects
    for update to anon
    using ( bucket_id = b and name = any(names) )
    with check ( bucket_id = b and name = any(names) );

  -- 删：保留删除权（应用未显式用到，留作运维兜底；如要更严可去掉本段）
  create policy "anon_delete_workbench_data" on storage.objects
    for delete to anon
    using ( bucket_id = b and name = any(names) );
end $$;

-- ③ 校验：应看到 4 条 anon 策略
select policyname, cmd, roles
  from pg_policies
 where schemaname = 'storage' and tablename = 'objects'
   and policyname like '%workbench_data';
```

## 残留风险（务必阅读 `SECURITY.md`）

- `anon` key 仍等于全权；混淆 ≠ 保密。
- 无用户隔离：所有库管员共享同一份云端数据。
- 要彻底消除风险，需另立项做后端代理（key 不出前端）或 Supabase Auth（但会与共享模型冲突）。

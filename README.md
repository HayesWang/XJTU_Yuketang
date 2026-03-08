# 雨课堂刷课助手（西安交通大学特化版）

这个仓库不是通用版雨课堂脚本。

它是针对 **西安交通大学雨课堂** 页面结构做过专门适配和调试的版本，重点适配：

- `https://xjtu.yuketang.cn/pro/lms/.../studycontent`
- 西交大课程目录页自动续跑
- 西交大 `pro/lms` 作业页自动答题
- 从第一个未完成课时开始刷，已完成内容自动跳过

如果你不是在 `xjtu.yuketang.cn` 用，先不要默认认为一定能直接用。

## 这个脚本能做什么

- 自动播放视频
- 自动进入下一个课时
- 目录页从第一个未完成内容开始
- 中途遇到已完成课时自动跳过
- 作业题截图后发送给 AI，自动选择答案
- 页面跳转、刷新后自动续跑

## 先看一句最重要的话

你要打开的是 **课程目录页**，也就是 `studycontent` 页面。

不要一开始就打开单独的视频页或单独的作业页。

正确示例：

```text
https://xjtu.yuketang.cn/pro/lms/xxxxx/xxxxx/studycontent
```

## 给完全不会 Tampermonkey 的新手

### 第 1 步：安装浏览器扩展 Tampermonkey

Tampermonkey 就是“油猴”扩展。

推荐浏览器：

- Google Chrome
- Microsoft Edge

安装方法：

1. 打开浏览器扩展商店
2. 搜索 `Tampermonkey`
3. 点击安装
4. 安装完成后，浏览器右上角会出现 Tampermonkey 图标

如果你已经装好了，可以直接看下一步。

### 第 2 步：把脚本导入 Tampermonkey

最简单的方法：

1. 点击浏览器右上角 Tampermonkey 图标
2. 点击“创建新脚本”
3. 把编辑器里原来的默认内容全部删掉
4. 打开本仓库里的 [yuketang.js](/Users/hayeswang/Downloads/yuketang-jiaoben-main/yuketang.js)
5. 复制这个文件的全部内容
6. 粘贴进 Tampermonkey 编辑器
7. 按 `Command + S`（Mac）或 `Ctrl + S`（Windows）保存

保存后，脚本就已经安装完成。

## AI 配置推荐

这份脚本当前推荐你直接使用：

- 平台：**硅基流动**
- 模型：**Qwen/Qwen3.5-397B-A17B**

原因很简单：

- 价格通常比很多闭源大模型更低
- 处理选择题、判断题这类基础题够用
- 兼容脚本现在的“截图题目发给 AI”模式

## 第 3 步：申请硅基流动 API Key

你需要自己准备一个 API Key，不然 AI 不能答题。

大致流程：

1. 打开硅基流动官网并注册账号
2. 进入 API Key 页面
3. 创建一个新的 Key
4. 复制保存这串 Key

如果账户没有余额，AI 答题会失败。

## 第 4 步：在脚本里配置 AI

进入西交大雨课堂课程目录页以后，页面左上角会出现脚本面板。

如果没看到面板：

- 刷新页面一次
- 确认 Tampermonkey 脚本已经启用
- 确认当前页面是 `xjtu.yuketang.cn` 的课程目录页

然后按下面填：

### AI 配置

- `API URL`：`https://api.siliconflow.cn/v1/chat/completions`
- `API Key`：填你自己的硅基流动 Key
- `Model`：`Qwen/Qwen3.5-397B-A17B`

### 功能开关

建议这样开：

- 开启 `AI 自动答题`
- 开启 `优先截图发给支持图像输入的 AI`

为什么要开截图模式：

- 雨课堂题目有时会有加密字体
- 直接读文字不稳定
- 截图给 AI 更适合当前西交大页面

## 第 5 步：正式开始刷课

1. 登录西安交通大学雨课堂
2. 进入目标课程
3. 打开课程目录页 `studycontent`
4. 点击脚本面板里的“开始刷课”

然后脚本会按这个顺序工作：

1. 从目录里找到第一个未完成课时
2. 如果是已完成课时，自动跳过
3. 如果是视频，自动播放
4. 如果是作业，自动截图题目并请求 AI
5. 提交后进入下一页
6. 页面跳转后自动续跑

## 这份西交大特化版和普通脚本的区别

这版不是简单把通用脚本搬过来。

它专门处理了西交大 `pro/lms` 下常见的几个问题：

- 目录页面板偶发不显示
- 视频播完跳下一个页面后脚本中断
- 目录页经常不是从第一个未完成课时开始
- 作业题因为页面结构和字体问题，普通 OCR 不稳定
- 作业页需要截图给 AI，而不是只取纯文本

如果你在西安交通大学雨课堂使用，这版比“全平台通用脚本”更合适。

## 新手最常见的错误

### 错误 1：打开错页面

错误做法：

- 直接进某个视频页
- 直接进某个作业页

正确做法：

- 先进入课程目录页 `studycontent`

### 错误 2：没保存脚本

很多新手把代码粘贴进 Tampermonkey 后，没有按保存。

必须保存后脚本才会生效。

### 错误 3：AI Key 没填对

常见表现：

- 点开始后视频能刷，作业不能答
- 面板里提示 AI 请求失败

这时优先检查：

- `API URL` 是否填成硅基流动地址
- `API Key` 是否正确
- 模型名是否是 `Qwen/Qwen3.5-397B-A17B`
- 账户是否有余额

### 错误 4：没开截图模式

这份脚本的作业流程是按“截图题目给 AI”优化的。

如果你把截图模式关了，题目识别稳定性会明显下降。

## 建议的使用习惯

- 先手动点开课程目录页，再启动脚本
- 刷课时尽量不要频繁手动切页面
- AI 额度不足时，先补额度再继续
- 如果脚本中断，回到 `studycontent` 页面重新点“开始刷课”

## 文件说明

- [yuketang.js](/Users/hayeswang/Downloads/yuketang-jiaoben-main/yuketang.js)：Tampermonkey 脚本本体
- [releaseLog.md](/Users/hayeswang/Downloads/yuketang-jiaoben-main/releaseLog.md)：更新记录

## 免责声明

本项目仅供学习、交流和前端自动化研究使用。

使用者需要自行理解脚本行为，并自行承担使用后果。

## 一句话总结

如果你是西安交通大学学生，且完全不会用 Tampermonkey，最短路径就是：

1. 安装 Tampermonkey
2. 把 [yuketang.js](/Users/hayeswang/Downloads/yuketang-jiaoben-main/yuketang.js) 全部复制进去并保存
3. 打开西交大雨课堂课程目录页 `studycontent`
4. 在面板里填硅基流动 Key
5. 模型填 `Qwen/Qwen3.5-397B-A17B`
6. 开启 AI 自动答题和截图模式
7. 点击“开始刷课”

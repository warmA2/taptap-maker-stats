# 第三方代码与致谢

## boomber3/taptap-maker-credits

- 仓库：https://github.com/boomber3/taptap-maker-credits
- 许可：MIT License
- 本项目用到的部分：**TapTap 开发者后台的数据接口与统计口径**
  （`developer.taptap.cn` 的工作室/应用列表、商店曝光与浏览、广告收益）
  以及「逐日比率求平均」等口径结论、空值/未结算/失败的处理原则。
- 改写了哪些：请求层与缓存按本项目结构重写（`background.js` 的 `devGet` / `queryDevApps` /
  `fetchDevExposure` / `fetchDevAd`），界面按本项目风格重做（`dashboard.html`、`sidepanel.html`）。
  原项目的页面内浮层面板、吉祥物素材、积分流水同步均未引入。

原作者版权声明：

```
MIT License

Copyright (c) 2026 boomber3

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

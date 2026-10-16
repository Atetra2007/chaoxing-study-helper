# 第三方组件与许可

本项目自身代码采用MIT许可证；下列组件保留各自版权与许可。

| 组件 | 版本 | 用途 | 许可 |
| --- | --- | --- | --- |
| pdf-lib | 1.17.1 | PDF与OCR页面处理 | MIT |
| @noble/hashes | 2.0.0 | 分块SHA-256校验 | MIT |
| @pdf-lib/standard-fonts | 1.0.0 | pdf-lib的字体度量 | MIT |
| @pdf-lib/upng | 1.0.1 | pdf-lib的PNG处理 | MIT |
| pako | 1.0.11 | pdf-lib压缩依赖 | MIT AND Zlib，见随附原文 |
| tslib | 1.14.1 | pdf-lib编译辅助函数 | 0BSD |

扩展构建保留 `vendor/pdf-lib-LICENSE.md`、`vendor/noble-hashes/LICENSE` 及 `vendor/licenses/` 下的相关许可原文。pdf-lib发行包内的依赖不因项目采用MIT而改变许可。

开发测试使用linkedom等依赖，不随扩展发布；版本由 `pnpm-lock.yaml` 锁定。可选本机OCR使用PaddleOCR、PaddlePaddle及配套Python依赖，清单见 `local_ocr/requirements-lock.txt`，首次准备时单独下载，未打入扩展ZIP；各依赖与模型遵循上游许可。

公开截图与演示中的课件由项目代码生成，不包含真实课程资料。用户自行保存的课件和笔记不属于本项目MIT许可的授权范围。

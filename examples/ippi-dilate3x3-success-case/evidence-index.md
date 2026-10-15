# C002 Evidence 索引与只读核验

[返回成功案例](README.md) · [当前生命周期](../../docs/guides/optimization-workflow.md)

核验时间：`2026-10-15T02:22:05.531Z`。本索引由现存记录和字节核验结果整理；它不是新的 Formal Evidence、Approval 或冻结 inventory 成员。

## 结论到原始记录

下表所有 C002 结论绑定同一 Candidate `candidate:d9c8eb6b-9131-4419-96a5-2fc154ddd0af`、Evidence `evidence:b83fc466921262907fa4b039099efc29a6402c3e6c412e6be4165a459400e6f4` 和后续 Approval `approval:07e6f6f5-2c0b-4e8d-9187-dae9500fc9d0`。表内 payload 路径相对于后文的冻结目录。

| 案例结论 | Experiment / 关联对象 | 可复核记录与字段 |
| --- | --- | --- |
| 首次 correctness 19/19 PASS、6 workloads、aggregate 4.6976×、Acceptance PASS | `experiment:e0ebd0cb-e9d1-4552-98ce-61836a35871c` | `results/first-formal.json`：19 条 VALID/PASS correctness measurements、60 个新 raw performance samples、`acceptance.weighted_geomean = 4.697578121498937` |
| 独立复验 correctness 19/19 PASS、6 workloads、aggregate 4.5867×、Acceptance PASS | `experiment:1d51a04f-4f29-49d3-8981-b0bc283eb9da` | `results/revalidation.json`：19 条 VALID/PASS correctness measurements、60 个新 raw samples、`acceptance.weighted_geomean = 4.586690971400966`；`results/revalidation-report.json` 保存独立 staging/build 信息 |
| 两次结果身份一致，聚合 speedup 变化 −2.3605% | 上述两个不同 Experiment ID | `results/comparison.json` 与两个结果文件的 candidate、baseline、evaluator、machine identity；逐 workload 差异仍完整保留 |
| C001 的 `minimum_1x1` 失败：1 mismatch；历史 Formal INVALID | `experiment:6330e4a1-1f86-4ad8-acf8-610757e92640`；parent C001 | `history/c001-failure.json`、`source/c001-Dilate3x3.cpp`；原始失败是 `COMMAND_OUTPUT_DIAGNOSTIC`，不能据 development speedup 声称 Formal PASS |
| H001 保留，C002 修复水平 halo indexing | `hypothesis:H001`；C001 → C002 | `history/hypotheses.json`、`history/candidates.json`、`source/c001-to-c002.patch`；C001 旧记录不补造 hypothesis_id |
| Candidate、Evidence、Approval 当前 APPROVED | `approval:07e6f6f5-2c0b-4e8d-9187-dae9500fc9d0` | 冻结包外的 `c002-human-approval.json`、`c002-evidence-finalization.json`，并与本地 SQLite 审批记录、Candidate 状态核对 |
| 历史 Task/Workflow 仍 FAILED；未 merge/delivery | 上述 Task/Workflow | `history/task.json`、只读 SQLite 查询和 finalization；冻结 `evidence.json` 中 `human_approval = NOT_REQUESTED` 是审批前快照，不改写 |

Revalidation 的 Runner 原始记录是 `SUCCEEDED / validity UNKNOWN`；Control Plane domain experiment 是 `SUCCEEDED / validity VALID`。首次 Formal 两层 validity 均为 VALID。没有把 Runner 原始 UNKNOWN 改写成 VALID。

冻结 policy 配置了 `confidence_level = 0.95`，但两次 gate 没有计算出 95% CI：缺少 `ci_lower` 时使用 median speedup ratio。保留记录的 Acceptance PASS，解释见[统计口径](../../docs/guides/optimization-workflow.md#统计口径)。

## 身份关联

| 对象 | 已查到的身份 |
| --- | --- |
| OptimizationTask | `opt-task:b15cfc3e-b17b-4769-93b0-5be1578ab3c3` |
| Workflow | `workflow:f5f600ba-514f-4ab1-954e-a2872b18da67` |
| Hypothesis | `hypothesis:H001` |
| C001 / parent Candidate | `candidate:cc0ccef3-8a53-474b-a9ef-1234de5fff89` |
| C002 | `candidate:d9c8eb6b-9131-4419-96a5-2fc154ddd0af` |
| C002 commit | `5831e6bc221122daf94c15799594caa99d0c52fc` |
| Source baseline commit | `23a39f8de2272c150e168a824b7839de3844661c` |
| Performance baseline | `ippi-ft-main-23a39f8d / main@23a39f8de2272c150e168a824b7839de3844661c` |
| Evaluator | `ippi-dilate3x3-64f-c1r@0.1.0` |
| Package | `ippi-ft@0.1.0` |
| Machine identity SHA-256 | `58e793cd7ed19e396bf49afb9ab01999b64a64e526f1bd1e9891f00bef2b9ce1` |
| Evidence | `evidence:b83fc466921262907fa4b039099efc29a6402c3e6c412e6be4165a459400e6f4` |
| Approval | `approval:07e6f6f5-2c0b-4e8d-9187-dae9500fc9d0` |
| Reviewer | `owner-directive-2026-10-14` |
| Approved at | `2026-10-14T06:30:28.492Z` |

| Digest 的用途 | 值 |
| --- | --- |
| Baseline binary SHA-256，两次归档副本均匹配 | `87805e10942159d8cf28b2cc48efe0cc690c1297631ee8f302d16f2e23c57b6a` |
| C002 binary SHA-256，两次归档副本均匹配 | `7d4a50abe9dba0c1b175928eca21d706fdd2678498c14efbafc7c179e64217d2` |
| Benchmark binary SHA-256，两次归档副本均匹配 | `26ce499dcdc3c370a54ac6e34fb76e26b5cd29a23b427b07b1da081f6326a475` |
| Evaluator content digest，当前 Qualified Loader 核验匹配 | `de9d376571a51a0e0a36dac9fee85e99cce57dc0340e90ad4476b34f143a868d` |
| Package content digest，当前 Loader 与冻结 Task reference 匹配 | `b436243c971f2495c71c8b84c3b7e465b26e941ac565312c5a27e6b314807255` |
| Evidence inventory digest，不是压缩包文件 SHA | `b83fc466921262907fa4b039099efc29a6402c3e6c412e6be4165a459400e6f4` |
| 冻结 tar.gz 的文件 SHA-256 | `81e844934d7641779df676462da0d18f804f40feb29969affb99047f3e244c2f` |
| `evidence-manifest.json` 的文件 SHA-256，目录与归档副本一致 | `0ca4e1481ac91f726d4b86b643cc01a92f9d211f6b451f8793bbe89628e7bc42` |

Evaluator、Package 和 Evidence content digest 都不能用单个 manifest/package.json 的文件 SHA 替代。Evidence inventory digest 按原实现对 `JSON.stringify(manifest.files)` 计算 SHA-256；逐文件 manifest 包含排序后的相对路径、字节数和 SHA。

## 原始资产的位置与获取

本工作区已访问：

- 冻结归档：`.phyopt/agent-ippi-dilate-20261010/evidence/c002-b83fc466921262907fa4b039099efc29a6402c3e6c412e6be4165a459400e6f4.tar.gz`（5846652 bytes）。
- 冻结目录：`.phyopt/agent-ippi-dilate-20261010/evidence/c002-b83fc466921262907fa4b039099efc29a6402c3e6c412e6be4165a459400e6f4/`；其 `evidence-manifest.json` 对应下面的 62 个 payload。
- 审批关联记录：`.phyopt/agent-ippi-dilate-20261010/` 下的三个 JSON，见下一表。
- SQLite：`.phyopt/agent-ippi-dilate-20261010/control-plane.sqlite`；本轮以 `DatabaseSync(..., { readOnly: true })` 查询，没有初始化、迁移、审批或改写历史。
- 历史操作脚本：同目录中的 `run-c002-formal.mjs`、`run-c002-revalidation.mjs`、`freeze-c002-evidence.mjs`、`approve-c002.mjs`。本轮只查阅调用关系，没有执行脚本。

上述 `.phyopt` 资产不随案例文档提交，普通 Git clone 无法直接取得；目前没有已配置的公开下载地址。需要向维护者取得原 tar.gz、对应原 manifest、三个审批关联 JSON；若要核对当前数据库状态，还需要 SQLite 的一致只读副本。只有 README/本索引时，必须标记原始 Evidence 未取得，不能以摘要代替核验。

归档中保存了 baseline/candidate/benchmark binaries 与采集时的远端 loaded paths。本轮没有连接 S5000C，也没有核验那些远端路径当前是否仍存在、原始供应商目录或完整源码归档是否仍可取；本轮验证范围是已取得的冻结副本及本地记录。

## 审批记录与冻结记录分开核验

| 冻结包外的记录（仓库根相对路径） | Bytes | 本轮 SHA-256 |
| --- | ---: | --- |
| `.phyopt/agent-ippi-dilate-20261010/c002-human-approval.json` | 5568 | `c50cabbd32d87103a2b2c63908d6f77314b65176429bd1683f3e1ad1d7699ff6` |
| `.phyopt/agent-ippi-dilate-20261010/c002-evidence-finalization.json` | 1133 | `08ae70dc0d1bb6fc534eab8d3747eb31699a28416ee39a98c91568f63914690d` |
| `.phyopt/agent-ippi-dilate-20261010/c002-evidence-freeze-receipt.json` | 939 | `144cd0966043ab0007732a580935c54ab2d053e15b28a98700f640aba002b1db` |

Approval 记录绑定 task/workflow/candidate、source baseline、performance baseline、evaluator digest、machine、两个 Experiment、Evidence identity/SHA、reviewer、approved_at 和显式 Owner authorization。本轮确认导出 Approval JSON 与 SQLite `optimization_approvals` 的记录完全一致；Finalization 中的 `approval_record_sha256` 匹配上表 Approval 文件 SHA。

冻结时 Candidate snapshot 为 FROZEN、`human_approval` 为 NOT_REQUESTED；新增 Approval 表达后续 APPROVED 状态。三个包外记录不能塞回旧归档并继续沿用旧 digest。领域 Approval Record 不由 `corepilot workflow approve` 创建，后者是另一条 merge/cleanup 路径。

## 本轮完成的核验

| 核验项 | 结果 |
| --- | --- |
| tar.gz 文件 SHA 与 Approval/Finalization 的引用 | MATCH |
| manifest 文件 SHA：目录副本与归档成员 | MATCH |
| inventory digest 与 Evidence ID/digest | MATCH |
| 62 个目录 payload：relative path / size / SHA | 62/62 MATCH |
| 62 个归档 payload：成员路径 / size / SHA | 62/62 MATCH；只读 stdout 获取，没有展开覆盖文件 |
| 两次结果的 Task/Candidate/Baseline/Evaluator/Machine 绑定 | MATCH |
| correctness / raw performance counts | 每次 19 条 VALID/PASS correctness、60 个 raw performance samples |
| 两次资源上下文与 acceptance | resource validity VALID；Acceptance PASS |
| 当前 Package/Evaluator | content digests 匹配冻结 reference；状态均 QUALIFIED |
| SQLite 与审批导出 | Approval 相同；Candidate APPROVED；历史 Task/Workflow FAILED |

文件身份核验不等于重新执行实验。本轮没有新 correctness/benchmark、Revalidation、Approval、merge 或 delivery。

## 只读核验方法

在持有原始资产的仓库根目录，先核对 tar.gz 与上表三个审批关联 JSON 的文件 SHA。PowerShell 示例：

~~~powershell
$caseRoot = Join-Path (Get-Location) '.phyopt/agent-ippi-dilate-20261010'
Get-FileHash -LiteralPath (Join-Path $caseRoot 'evidence/c002-b83fc466921262907fa4b039099efc29a6402c3e6c412e6be4165a459400e6f4.tar.gz') -Algorithm SHA256
Get-FileHash -LiteralPath (Join-Path $caseRoot 'c002-human-approval.json') -Algorithm SHA256
Get-FileHash -LiteralPath (Join-Path $caseRoot 'c002-evidence-finalization.json') -Algorithm SHA256
Get-FileHash -LiteralPath (Join-Path $caseRoot 'c002-evidence-freeze-receipt.json') -Algorithm SHA256
~~~

以下 Node.js + tar 示例通过 stdout 读取归档成员，核验原 manifest、inventory 与所有 payload；不执行实验或写入原始资产。需要原 manifest 位于上述冻结目录：

~~~powershell
@'
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const digest = 'b83fc466921262907fa4b039099efc29a6402c3e6c412e6be4165a459400e6f4';
const directory = '.phyopt/agent-ippi-dilate-20261010/evidence/c002-' + digest;
const archive = directory + '.tar.gz';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const manifestBytes = fs.readFileSync(path.join(directory, 'evidence-manifest.json'));
assert.equal(sha(fs.readFileSync(archive)), '81e844934d7641779df676462da0d18f804f40feb29969affb99047f3e244c2f');
assert.equal(sha(manifestBytes), '0ca4e1481ac91f726d4b86b643cc01a92f9d211f6b451f8793bbe89628e7bc42');
const manifest = JSON.parse(manifestBytes.toString('utf8'));
assert.equal(manifest.digest, digest);
assert.equal(sha(JSON.stringify(manifest.files)), digest);
assert.equal(manifest.files.length, 62);
const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
assert.equal(listing.status, 0);
const members = listing.stdout.trim().split(/\r?\n/);
function archiveBytes(relativePath, size) {
  const member = members.find(value => value.replace(/^\.\//, '') === relativePath);
  assert.ok(member);
  const result = spawnSync('tar', ['-xOzf', archive, member], {
    maxBuffer: Math.max(size + 1024, 4 * 1024 * 1024),
  });
  assert.equal(result.status, 0);
  return result.stdout;
}
assert.equal(sha(archiveBytes('evidence-manifest.json', manifestBytes.length)), sha(manifestBytes));
let localCount = 0;
for (const item of manifest.files) {
  const bytes = archiveBytes(item.relative_path, item.size_bytes);
  assert.equal(bytes.length, item.size_bytes);
  assert.equal(sha(bytes), item.sha256);
  const localPath = path.join(directory, item.relative_path);
  if (fs.existsSync(localPath)) {
    const local = fs.readFileSync(localPath);
    assert.equal(local.length, item.size_bytes);
    assert.equal(sha(local), item.sha256);
    localCount++;
  }
}
console.log({ archive_payloads_verified: manifest.files.length, local_payloads_verified: localCount });
'@ | node --input-type=module
~~~

完成字节核验后，再用上面的结论关联表读取实际记录：检查两个 Experiment ID 不同但 candidate/baseline/evaluator/machine 相同、19 cases 与 raw samples 完整、资源有效、实际 acceptance，以及包外 Approval 对同一 Evidence 的绑定。只验证 archive SHA 或读取本索引不等于独立审阅了所有实验语义。缺文件、hash 不符或远端未访问时，应记录该事实，不推测补齐。

生产字节核验规则可对照 [frozen-evidence verifier](../../src/workspace/frozen-evidence.ts)；本索引不提供自动审批或重放操作脚本的命令。

## 已核验的冻结 payload inventory

路径相对于冻结目录 `.phyopt/agent-ippi-dilate-20261010/evidence/c002-b83fc466921262907fa4b039099efc29a6402c3e6c412e6be4165a459400e6f4/`，不是相对于当前案例目录。表中的 `README.md` 指冻结包内 README，未被本轮案例文档修改。历史 external-baseline 调查文件仍作为原 snapshot 保留，不构成本案性能 baseline。

| Frozen relative path | Bytes | SHA-256（目录与归档均匹配） |
| --- | ---: | --- |
| `README.md` | 1359 | `a1b7baf3d2403eed7fe14cf32bca1e10f862f96f37fb6792a9f58301847e5019` |
| `binaries/first-formal/baseline.so` | 4631144 | `87805e10942159d8cf28b2cc48efe0cc690c1297631ee8f302d16f2e23c57b6a` |
| `binaries/first-formal/candidate.so` | 4631144 | `7d4a50abe9dba0c1b175928eca21d706fdd2678498c14efbafc7c179e64217d2` |
| `binaries/first-formal/dilate_evaluator` | 72536 | `26ce499dcdc3c370a54ac6e34fb76e26b5cd29a23b427b07b1da081f6326a475` |
| `binaries/revalidation/baseline.so` | 4631144 | `87805e10942159d8cf28b2cc48efe0cc690c1297631ee8f302d16f2e23c57b6a` |
| `binaries/revalidation/candidate.so` | 4631144 | `7d4a50abe9dba0c1b175928eca21d706fdd2678498c14efbafc7c179e64217d2` |
| `binaries/revalidation/dilate_evaluator` | 72536 | `26ce499dcdc3c370a54ac6e34fb76e26b5cd29a23b427b07b1da081f6326a475` |
| `contracts/evaluator/benchmark/output-schema.json` | 181 | `a59f8bce1ec8b957e702faf7b805caeb4488c781bafd94984344020db3987214` |
| `contracts/evaluator/benchmark/policy.json` | 661 | `7cc0daedcdb21725b5b586d1f58630866055572f6ab9e601f33527333ff8bb28` |
| `contracts/evaluator/benchmark/run-sample.sh` | 743 | `cabd619c283f4c99aaeb28843f85a3e8b9527e2e767746681ed330f247b557fd` |
| `contracts/evaluator/benchmark/workloads.json` | 1272 | `d6898ba1596fd2750b6b16e4ce5f66aaf63749cfe35d62b2996832b909bde96d` |
| `contracts/evaluator/correctness/cases.json` | 4021 | `446ece54c710ecad25b3ddc1187350e4f2fa803d1723b426ccf12bad91e076e3` |
| `contracts/evaluator/correctness/policy.json` | 902 | `66d0add9db9dd0ec29395ed5d35daa6670533253420ac035d8e67f79210ad911` |
| `contracts/evaluator/correctness/run-case.sh` | 743 | `2335026d30968ba35beef2c36ddd3f8264fd7297910dea25bfe17f7b3fa4a8ed` |
| `contracts/evaluator/correctness/scalar_oracle.c` | 721 | `60203554b71ab500462ed226c40e54bb75f91828d3deba1713a1409614d39de2` |
| `contracts/evaluator/correctness/scalar_oracle.h` | 217 | `7b3ea87e19fa688f24b40c1681c4b95d41de5e1c98fa57bc7bf75776a320c168` |
| `contracts/evaluator/harness/dilate_evaluator.c` | 12451 | `ae1d3f1273025cf28b8f1e89db3c0b434c9739999331ef8a0585dc030bd41c79` |
| `contracts/evaluator/manifest.json` | 5822 | `61b85e88c193cba4e3c0781dcf67c05a8c31fd8e53995775a0f5ecf347ad1eee` |
| `contracts/evaluator/qualification.json` | 2276 | `f38d05133dce86a0c0416430fd1e819a6b2630be2c5892d2051b8536e6d73338` |
| `contracts/evaluator/scripts/build-evaluator.sh` | 407 | `8e93d7ebe4901fca7bdfc7e5aa1ae9763aaebb271c3e25e191716020275f8338` |
| `contracts/evaluator/scripts/run-correctness.sh` | 306 | `1e29069763194c324a6537c61a0d108691ea390827e2318fe0e2d81f428db8c8` |
| `contracts/evaluator/scripts/run-performance.sh` | 308 | `bdbd6e0dea96681fa77baa7e590a9002a9feb32355109c82d35e71a624a79ac2` |
| `contracts/package/baselines/performance.json` | 6412 | `b1b19d3bce022d3981965834f5f967f1a51eb7d480ca9b3f071a7e9637e675c9` |
| `contracts/package/baselines/self-baseline.json` | 2630 | `497ddfd46ca4a2dc1c58f702f510b34fe7e25bdcba986fa1d188488e4fb8665b` |
| `contracts/package/build/discovered.json` | 131 | `940657411bf3438a896eba831e4a89a60abd07611138d11788509ccde0b310b0` |
| `contracts/package/build/frozen-cmake.json` | 357 | `5b02fd0c08fe686dbd9a84a9a4243aaef876a253ebc176fafe28ba752df6c852` |
| `contracts/package/development/benchmark.json` | 90 | `533ebedec2a7c42c629a76e890707a11f35aabc2ed21eb10c3c728b1f8c39624` |
| `contracts/package/development/tests.json` | 85647 | `a644d6014bf3c11b524d199fada4a28e23883ddeb958824aa8a87fadeb134987` |
| `contracts/package/onboarding/binary-baseline-evidence.json` | 2393 | `b3fcc524f52580e68bc62d3fe3bfe07459f5367016b6d3a00ebf2b39796be2ee` |
| `contracts/package/onboarding/evidence.json` | 3106001 | `8b0443ca39042ced6b3556977403b874b45f8d0411f8f908aef7dec585848d67` |
| `contracts/package/onboarding/target-candidates.json` | 5065 | `8f5ebafd0189f8a22eac953d5af9f12092a7949a80bb3fcde63a01d1c5d8cbb1` |
| `contracts/package/package.json` | 14933 | `1c123ade114241377decea087983958c8359cb51506360ab453cbeb5493b6806` |
| `contracts/package/qualification/build-binding-2026-10-10.json` | 1567 | `f31392a9429d5f4f2e8c61dcfab5e2d69cae0e141c7354a9ade3501692484fdb` |
| `contracts/package/qualification/historical-compatibility-runtime-2026-10-08.json` | 12575 | `ff4de68e8a385ce2d2f44dbea4d0376ba575dd57ef11bba10049fe1c2281b969` |
| `contracts/package/qualification/probe-original-baseline.c` | 4479 | `c594ebbcf042e62a488f4cea3e3678f73f483bd173610c6b9eaf676c5af998da` |
| `contracts/package/qualification/qualify-self-baseline.cjs` | 7135 | `baf8b9e1f5cc5fc55b1685c9a3709c4ca13575151fd251cbcafcc16c17408ecf` |
| `contracts/package/qualification/runtime-symbol-closure-2026-10-08.json` | 4828 | `381b23d1ad46b7a704b6450c8f182a2fbc488aae0c8f88ba12bc9d8e740a8464` |
| `contracts/package/qualification/target-runtime-2026-10-08.json` | 2601 | `191fba0c24bc504843fe00cc1a52614fcbfe869364b7cf6fd79d9d6abb5b6b6e` |
| `contracts/package/qualification/target-self-baseline-2026-10-08.json` | 2153 | `e11d9c45360403f462c30ae4115cd61999fb32cfd0d859e215780337d0ad2323` |
| `contracts/package/qualification/target-self-baseline-2026-10-10.json` | 2296 | `2b2c40d8c195f47a4c04a6e89a41af1c57b4d049965c86c57d5994df75d1071e` |
| `contracts/validation-testpack.json` | 12022 | `2b9ccee8f43f6f391ab5c708fc74cee53020bbc34b30e4a1ab7e27ec7baf3401` |
| `evidence.json` | 17006 | `d114fddfdaa08c6ea4145a49fd01f5aeee01dca1650e58c6d747770617504d53` |
| `history/c001-failure.json` | 74634 | `b2497586290f6911b10729c3c2e9eb55dfe3112792d4b3cd1e4b22c91e1f9e71` |
| `history/candidates.json` | 10145 | `6dd275eca9fdaba44321972d7c101edca79222c3f38e18c382c162c3a403fbc0` |
| `history/experiments.json` | 38912 | `cce816dfb8e68ec0e4b97ac5ba5bd000b3ab118de052a8c6548ebde7d1c0e59b` |
| `history/hypotheses.json` | 2201 | `21082be00be1155a191fd5eff521a20f40483460803f89302551285f3ab59342` |
| `history/hypothesis-outcomes.json` | 18101 | `240c360b18edbb172fa2380fe2e8a0552c6cbe0ef4937fa732f81169c35a3a9f` |
| `history/previous-records/continuation-h001-c002-benchmark.json` | 17358 | `cfefb386d3a064fb0b268d35a3cb0766062f3b3d7d012ab0b1a722047a736f5a` |
| `history/previous-records/continuation-h001-c002-development.json` | 6563 | `ddd5869802db8d3036c9c0e8cfc455a514a3c23330d7a98df5421cd289a7322c` |
| `history/previous-records/continuation-h001-c002-formal.json` | 9293 | `8a076ed7e21430c5e16c538ea13a9021d8c3f082f42b4e620584d91619c5ac8a` |
| `history/previous-records/final-evidence.json` | 21927 | `49ecb67a74b81a5ea54c0bbba0df0f3f600af4dd2418132c48c7bae95e761261` |
| `history/previous-records/final-runner-facts.json` | 981647 | `e0b8eff859ee45844069bb902895171e1e509ce2f31381260248f933ab886796` |
| `history/task.json` | 18308 | `eb460f3ef3d3849d68937ab803e295386d9cef6d48f3a5a915d1d30ff3cc2183` |
| `results/comparison.json` | 3535 | `bd42b10c6d7cc01bf3289fcbd4dc800a863560c7017ee4afa9dc3b753932dcfb` |
| `results/first-formal.json` | 980649 | `138eaab3c3b1c22a560b8066590d800c530d75874e78c2d53f269778e59f91e0` |
| `results/revalidation-report.json` | 12583 | `ed113f8b9bd62a1ac5d39a6148a1f9f8af061d14b9935db48b3cffcfc91b2c2a` |
| `results/revalidation.json` | 935173 | `7b46d7076149a72d4cd70b73bdd853c05e00487d18bbc6ed28e5d8ac08993e67` |
| `source/baseline-Dilate3x3.cpp` | 1873 | `1ab823545f715dd51571bf9bae245296a57436d9d3daef4b82d6f102570899e6` |
| `source/baseline-to-c002.patch` | 4034 | `fa9faa26ca67110a67decd5bfc6bc0b169b4b9db4f2c4bc7262be114a8b83ed8` |
| `source/c001-Dilate3x3.cpp` | 3374 | `ea0bcc2b7ece72d73587e4a0c77c545115e857635d66a7bb9d0b226e8f97cdc8` |
| `source/c001-to-c002.patch` | 682 | `7013ef7db3f07ba2e08a2902010bd9341623e75da83c91595eba37957edaf788` |
| `source/c002-Dilate3x3.cpp` | 3374 | `eec067b6772b295ca4fee0e98e924f397e48b904b00fd9fbdfb7ff9f5652b880` |

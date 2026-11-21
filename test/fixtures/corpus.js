// 読み取り精度の検証セット(実務でよくある書き方を想定して作った、架空の文面)
// expect: 自動で仕分けるべき内容。review: true は「自動で仕分けず、要確認にすべき」書類
const C = [
  { code: '10001', name: '株式会社さくら建設', aliases: ['さくら建設'], fiscalEndMonth: 3 },
  { code: '10002', name: '有限会社みなと商店', aliases: ['みなと商店'], fiscalEndMonth: 12 },
  { code: '10003', name: '合同会社ひかりデザイン', aliases: ['ひかりデザイン'], fiscalEndMonth: 6 },
  { code: '10004', name: '株式会社あおば食品', aliases: ['あおば食品'], fiscalEndMonth: 9 },
  { code: '10005', name: '医療法人社団みどり会', aliases: ['みどり会'], fiscalEndMonth: 3 },
  { code: '10006', name: '山田 太郎', aliases: ['山田太郎'], fiscalEndMonth: 12 }
];
const cases = [
  // ---- 月次:会計期間(通期)と対象月が両方書かれている ----
  { id: 'm1', text: '月次試算表\n株式会社さくら建設\n会計期間 自 令和6年4月1日 至 令和7年3月31日\n令和7年2月分\n売上高 1,200,000', expect: { docType: '月次試算表', clientCode: '10001', periodEnd: '2025-02-28' } },
  { id: 'm2', text: '合計残高試算表(貸借対照表)\n顧問先コード:10002 有限会社みなと商店\n第32期 自令和6年1月1日 至令和6年12月31日\n対象月:令和6年11月度', expect: { docType: '月次試算表', clientCode: '10002', periodEnd: '2024-11-30' } },
  { id: 'm3', text: '残高試算表\n(株)さくら建設 御中\n2025年4月1日〜2025年4月30日', expect: { docType: '月次試算表', clientCode: '10001', periodEnd: '2025-04-30' } },
  { id: 'm4', text: '月 次 試 算 表\n会社名 合同会社 ひかりデザイン\nR7.5月分', expect: { docType: '月次試算表', clientCode: '10003', periodEnd: '2025-05-31' } },
  { id: 'm5', text: '試算表(月次)\n株式会社あおば食品\n令和7年10月1日から令和7年10月31日まで', expect: { docType: '月次試算表', clientCode: '10004', periodEnd: '2025-10-31' } },
  { id: 'm6', text: '月次決算報告\n試算表\nさくら建設\n2025/06', expect: { docType: '月次試算表', clientCode: '10001', periodEnd: '2025-06-30' } },
  { id: 'm7', text: '変動損益計算書\n株式会社さくら建設\n令和7年7月(単月)\n売上高 900,000', expect: { docType: '月次試算表', clientCode: '10001', periodEnd: '2025-07-31' } },
  // ---- 決算書:前期と当期が並んでいる ----
  { id: 'f1', text: '決算報告書\n株式会社さくら建設\n前期 自 令和5年4月1日 至 令和6年3月31日\n当期 自 令和6年4月1日 至 令和7年3月31日\n当期純利益 3,000,000', expect: { docType: '決算書', clientCode: '10001', periodEnd: '2025-03-31' } },
  { id: 'f2', text: '貸借対照表\n令和6年12月31日現在\n有限会社みなと商店', expect: { docType: '決算書', clientCode: '10002', periodEnd: '2024-12-31' } },
  { id: 'f3', text: '損益計算書\n合同会社ひかりデザイン\nR6.7.1~R7.6.30', expect: { docType: '決算書', clientCode: '10003', periodEnd: '2025-06-30' } },
  { id: 'f4', text: '第18期 決算書\n株式会社さくら建設\n(令和6年4月1日から令和7年3月31日まで)', expect: { docType: '決算書', clientCode: '10001', periodEnd: '2025-03-31' } },
  { id: 'f5', text: '決算報告書\n医療法人社団みどり会\n令和6年度(自 令和6年4月1日 至 令和7年3月31日)', expect: { docType: '決算書', clientCode: '10005', periodEnd: '2025-03-31' } },
  { id: 'f6', text: '株主資本等変動計算書\n株式会社あおば食品\n自 2024年10月1日 至 2025年9月30日', expect: { docType: '決算書', clientCode: '10004', periodEnd: '2025-09-30' } },
  // ---- 申告書 ----
  { id: 't1', text: '法人税申告書 別表一\n法人名 株式会社さくら建設\n事業年度 令和 6年 4月 1日 から 令和 7年 3月31日 まで\n差引確定法人税額 500,000', expect: { docType: '法人税申告書', clientCode: '10001', periodEnd: '2025-03-31' } },
  { id: 't2', text: '別表四 所得の金額の計算に関する明細書\n法人名 有限会社みなと商店\n事業年度 自令和6・1・1 至令和6・12・31', expect: { docType: '法人税申告書', clientCode: '10002', periodEnd: '2024-12-31' } },
  { id: 't3', text: '消費税及び地方消費税の確定申告書\n名称 合同会社ひかりデザイン\n課税期間 自 令和6年7月1日 至 令和7年6月30日\n納付税額 300,000', expect: { docType: '消費税申告書', clientCode: '10003', periodEnd: '2025-06-30' } },
  { id: 't4', text: '消費税の中間申告書\n株式会社さくら建設\n課税期間 自令和7年4月1日 至令和8年3月31日\n中間申告対象期間 自令和7年4月1日 至令和7年9月30日', expect: { docType: '消費税申告書', clientCode: '10001', periodEnd: '2026-03-31' } },
  { id: 't5', text: '法人事業概況説明書\n法人名 株式会社あおば食品\n自 令和6年10月1日 至 令和7年9月30日', review: true },
  { id: 't6', text: '所得税及び復興特別所得税の確定申告書\n令和6年分\n氏名 山田 太郎', expect: { docType: '所得税確定申告書', clientCode: '10006', periodEnd: '2024-12-31' } }, // 所得税確定申告書に対応したため、自動で仕分ける
  // ---- 源泉・年末調整 ----
  { id: 'w1', text: '給与所得・退職所得等の所得税徴収高計算書(納期特例分)\n徴収義務者 氏名又は名称 有限会社みなと商店\n令和7年7月から令和7年12月分\n合計額 80,000', expect: { docType: '源泉所得税納付書', clientCode: '10002', periodEnd: '2025-12-31' } },
  { id: 'w2', text: '所得税徴収高計算書\n株式会社さくら建設\n納期等の区分 令和7年3月\n支払年月日 令和7年3月25日\n本税 45,000', expect: { docType: '源泉所得税納付書', clientCode: '10001', periodEnd: '2025-03-31' } },
  { id: 'w3', text: '令和6年分 給与所得の源泉徴収票\n支払者 氏名又は名称 株式会社あおば食品\n支払を受ける者 氏名 鈴木 一郎\n源泉徴収税額 86,400', expect: { docType: '源泉徴収票・年末調整', clientCode: '10004', periodEnd: '2024-12-31' } },
  { id: 'w4', text: '令和6年分 年末調整一覧表\n合同会社ひかりデザイン', expect: { docType: '源泉徴収票・年末調整', clientCode: '10003', periodEnd: '2024-12-31' } },
  { id: 'w5', text: '令和6年分 給与所得の源泉徴収票等の法定調書合計表\n提出者 氏名又は名称 株式会社さくら建設\n提出日 令和7年1月28日', expect: { docType: '法定調書合計表', clientCode: '10001', periodEnd: '2024-12-31' } },
  { id: 'w6', text: '給与支払報告書(総括表)\n令和7年度(令和6年分)\n給与支払者の氏名又は名称 有限会社みなと商店', expect: { docType: '給与支払報告書', clientCode: '10002', periodEnd: '2024-12-31' } },
  { id: 'w7', text: '償却資産申告書(償却資産課税台帳)\n令和7年度\n所有者 氏名又は名称 株式会社さくら建設', expect: { docType: '償却資産申告書', clientCode: '10001', periodEnd: '2025-12-31' } },
  // ---- その他の書類 ----
  { id: 'o1', text: '総勘定元帳\n株式会社さくら建設\n自 令和6年4月1日 至 令和7年3月31日\n現金', expect: { docType: '総勘定元帳', clientCode: '10001', periodEnd: '2025-03-31' } },
  { id: 'o2', text: '御請求書\n株式会社さくら建設 御中\n令和7年5月分 顧問料\nご請求金額 55,000円\nサンプル会計事務所', expect: { docType: '請求書', clientCode: '10001', periodEnd: '2025-05-31' } },
  { id: 'o3', text: '定時株主総会議事録\n株式会社あおば食品\n開催日時 令和7年11月25日 午前10時', expect: { docType: '議事録', clientCode: '10004', periodEnd: '2025-11-25' } },
  { id: 'o4', text: '青色申告の承認申請書\n法人名 合同会社ひかりデザイン\n提出日 令和7年7月10日', expect: { docType: '届出書・申請書', clientCode: '10003', periodEnd: '2025-07-10' } },
  { id: 'o5', text: '異動届出書\n令和7年6月1日\n法人名 株式会社さくら建設', expect: { docType: '届出書・申請書', clientCode: '10001', periodEnd: '2025-06-01' } },
  // ---- 文字のゆれ(全角・空白・OCR風) ----
  { id: 'z1', text: '月次試算表\n顧問先コード：10004\n株式会社 あおば食品\n令和7年3月分', expect: { docType: '月次試算表', clientCode: '10004', periodEnd: '2025-03-31' } },
  { id: 'z2', text: '決 算 報 告 書\n自 令 和 6 年 4 月 1 日\n至 令 和 7 年 3 月 31 日\n株 式 会 社 さ く ら 建 設', expect: { docType: '決算書', clientCode: '10001', periodEnd: '2025-03-31' } },
  { id: 'z3', text: '㈱さくら建設\n月次試算表\n令和7年8月分', expect: { docType: '月次試算表', clientCode: '10001', periodEnd: '2025-08-31' } },
  { id: 'z4', text: '月次試算表\n(医)みどり会\n2025年9月度', expect: { docType: '月次試算表', clientCode: '10005', periodEnd: '2025-09-30' } },
  // ---- 自動で仕分けてはいけない書類(要確認にすべき) ----
  { id: 'r1', text: '月次試算表\n株式会社さくら工業\n令和7年3月分', review: true },
  { id: 'r2', text: '月次試算表\n令和7年3月分\n売上高 100', review: true },
  { id: 'r3', text: '月次試算表\n株式会社さくら建設', review: true },
  { id: 'r4', text: '送付状\n株式会社さくら建設 御中\n月次試算表と決算書をお送りします。\n令和7年3月分', review: true },
  { id: 'r5', text: '月次試算表\n株式会社さくら建設\n取引先:有限会社みなと商店 売掛金\n令和7年3月分', expect: { docType: '月次試算表', clientCode: '10001', periodEnd: '2025-03-31' } },
  { id: 'r6', text: '比較損益計算書\n株式会社さくら建設\n令和6年3月期 令和7年3月期', expect: { docType: '決算書', clientCode: '10001', periodEnd: '2025-03-31' } },
  { id: 'r7', text: '見積書\n有限会社みなと商店 御中\n令和7年3月10日', review: true },
  { id: 'r8', text: '月次試算表\n顧問先コード:10001\n顧問先名:有限会社みなと商店\n令和7年3月分', review: true }
];
module.exports = { clients: C, cases };

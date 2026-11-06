[English](README.md) | 绠€浣撲腑鏂?
# dsh-qgis

缁?DeepSeek Harness 鐨?QGIS 4 鑳藉姏鎻掍欢銆傚畠杩愯涓€涓棤鐣岄潰鐨?PyQGIS 寮曟搸锛?*涓嶉渶瑕佹墦寮€ QGIS**锛屼篃涓嶆秹鍙婁换浣?GUI銆?
- **娓呯偣鏁版嵁**锛氭壂鎻忔枃浠躲€佹枃浠跺す銆乣.qgz` 宸ョ▼锛岃繑鍥?CRS銆佸嚑浣曠被鍨嬨€佸瓧娈点€佽寖鍥淬€佽绱犳暟锛?- **鎵剧畻娉?*锛氬湪 769 涓鐞嗙畻娉曢噷鎸夊叧閿瘝鎼滅储锛屾垨璇诲彇鏌愪釜绠楁硶鐨勫畬鏁村弬鏁拌〃锛?- **璺戠畻娉?*锛氫换鎰?processing 绠楁硶锛屼骇鐗╁啓鍏?`exports/`锛屽悓鏃剁敓鎴愬彲澶嶈窇鐨?Python 鑴氭湰锛?- **璐ㄦ**锛欳RS銆佺┖鍑犱綍/闈炴硶鍑犱綍銆佹尝娈电粺璁°€乶odata锛屽厛楠岃瘉鍐嶆姤鏁帮紱
- **鍑哄浘**锛?00 dpi 鎺掔増鍥撅紝鍚浘渚嬨€佹瘮渚嬪昂銆佹寚鍖楅拡锛屼腑鏂囨爣娉ㄦ甯革紱
- **鏂规硶璁板綍**锛氭瘡涓€姝ヨ嚜鍔ㄨ褰曪紝涓€閿鍑?Methods 娈佃惤銆?
## 鐜瑕佹眰

- Windows锛屽凡瀹夎 QGIS **4.x**锛堝凡楠岃瘉 4.0.2锛夈€傛彃浠朵細鑷姩鍙戠幇瀹夎浣嶇疆锛涘鏋滃湪闈炲父瑙勭洰褰曪紝agent 鍙互瀹氫綅
  `bin\qgis-bin.exe` 骞剁敤 `qgis_status qgis_dir=<鐩綍>` 璁颁綇瀹冦€?- 甯︽彃浠剁鐞嗗櫒鐨?DeepSeek Harness銆?- 涓嶉渶瑕侀澶?Python 鐜锛氱洿鎺ョ敤 QGIS 鑷甫鐨勮В閲婂櫒銆?
## 瀹夎

### npm

鐩墠鍙互鐩存帴瑁?Release 閲岀殑 tarball锛涘彂甯冨埌 npm registry 鍚庡彲浠ユ寜鍖呭悕瀹夎銆?
```bash
npm install -g https://github.com/cdllI/dsh-qgis/releases/download/v0.2.1/dsh-qgis-0.2.1.tgz
# 鍙戝竷鍚庯細npm install -g dsh-qgis
```

鐒跺悗璁?agent 鐢?`plugin_manager` 鐨?`install_bundle`锛岀洰鏍囧～ npm 鍏ㄥ眬鍖呯洰褰曪紙Windows锛?`%APPDATA%\npm\node_modules\dsh-qgis`锛屽彲浠ョ敤 `npm root -g` 鏌ワ級銆?
### 浠庢簮鐮?
```powershell
git clone https://github.com/cdllI/dsh-qgis
```

鐒跺悗 `install_bundle` 濉?`<clone>\dsh-qgis` 鐨勭粷瀵硅矾寰勩€傛湰鍦版敼鍔ㄧ敤鍓湰娴嬭瘯锛?
```powershell
Copy-Item -Recurse -Force dsh-qgis .install\dsh-qgis
```

濡傛灉 QGIS 涓嶅湪鑷姩鍙戠幇鑼冨洿鍐咃紝涓嶈鎵嬫敼閰嶇疆鏂囦欢锛氳 agent 鎵惧埌鍖呭惈 `bin\qgis-bin.exe` 鐨勭洰褰曪紝璋冪敤
`qgis_status qgis_dir=<鐩綍>`銆傛彃浠朵細浠庤鐩綍鍚姩寮曟搸锛屽苟鎶婇€夋嫨鍐欏叆 `qgis.config.json` 渚涗互鍚庝娇鐢ㄣ€?
瀹夎鍚庯紝浼氳瘽閲屽嚭鐜?`qgis_*` 宸ュ叿銆傚埢鎰忎笉鍋氫晶鏍忛潰鏉匡細`qgis_map` 鐩存帴鎶?PNG 鍙戝埌鑱婂ぉ妗嗭紝姣忎釜宸ュ叿閮戒細杩斿洖淇濆瓨鐨勭粷瀵硅矾寰勩€?
## 蹇€熷紑濮?
> 鎵弿鎴戠殑鏁版嵁鏂囦欢澶癸紝鎶婅€曞湴鍜屾案涔呭熀鏈啘鐢板仛鍙犲姞锛岀粺璁¤鍗犻潰绉紝鏈€鍚庡嚭涓€寮?300dpi 鐨勫浘銆?
agent 浼氫緷娆¤皟鐢?`qgis_scan` 鈫?`qgis_find` 鈫?`qgis_run` 鈫?`qgis_check` 鈫?`qgis_map` 鈫?`qgis_history`銆?浣犱細寰楀埌 `exports/` 涓嬬殑鍥惧眰鏂囦欢銆佸璇濋噷鐨?PNG 鍥撅紝浠ュ強涓€浠芥柟娉曡褰曘€?
## 宸ュ叿

| 宸ュ叿 | 鐢ㄩ€?|
|---|---|
| `qgis_status` | QGIS 鐗堟湰銆佹暟鎹簮銆佺畻娉曟暟銆佷腑鏂囧瓧浣撱€佽緭鍑虹洰褰曘€傚厛璺戣繖涓€?|
| `qgis_scan` | 娓呯偣鏁版嵁涓庡伐绋嬶紱涓嶆墦寮€ QGIS 涔熻兘璇?`.qgz` 鐨勫浘灞傛竻鍗曘€?|
| `qgis_find` | 绠楁硶鍏抽敭璇嶆悳绱紱鎸?id 璇诲畬鏁村弬鏁般€?|
| `qgis_run` | 鏃犵晫闈㈣繍琛屼竴涓畻娉曪紱榛樿杈撳嚭璺緞銆佹棩蹇椼€佽剼鏈€?|
| `qgis_check` | 鐭㈤噺/鏍呮牸璐ㄦ锛屽甫璀﹀憡銆?|
| `qgis_map` | 300 dpi 鎺掔増鍥撅紙鍙悓鏃跺嚭 PDF锛夛紝鍥句緥/姣斾緥灏?鎸囧寳閽堛€?|
| `qgis_history` | 鍒楀嚭姝ラ锛屾垨瀵煎嚭 Methods 鏂囨。銆?|

## 闄愬埗

- 浠呮敮鎸?QGIS 4.x锛圦GIS 3 鐨勬彃浠?API 涓嶅悓锛夈€?- 鍗?worker 涓茶鎵ц锛氶暱绠楁硶浼氭尅浣忎笅涓€娆″伐鍏疯皟鐢紝浣嗕笉浼氬喕缁撲换浣?QGIS 绐楀彛銆?- 涓嶆墦寮€/缂栬緫/淇濆瓨 `.qgz` 宸ョ▼锛屽彧璇诲彇宸ョ▼閲岀殑鍥惧眰娓呭崟銆?- 鍒绘剰涓嶆毚闇测€滄墽琛屼换鎰?PyQGIS 浠ｇ爜鈥濈殑宸ュ叿銆?

#!/usr/bin/env python3
"""YALNIZ GELISTIRICI TESTI (Python Playwright + Chromium gerekir; kullanici icin gerekmez).

Onkosul (iki ayri terminal):
  node tools/ui-test/mock-technocore.mjs 5299
  CLOSECALL_TEST=1 CLOSECALL_UPSTREAM=http://127.0.0.1:5299 node ui/serve.mjs 5199
Calistirma:
  python3 tools/ui-test/e2e.py <test-anahtari.json> <cikti-klasoru>

Akis: sayfa yuklenir -> defter kontrolu -> test anahtari dosyadan yuklenir -> kayit -> teklif -> kabul ->
sahte hakem turu -> durumlar -> harici imza modu -> localStorage'da anahtar olmadigi kontrolu.
Gonderilen her kayit ayrica verify-posted.mjs ile cekirdekten bagimsiz dogrulanir.
"""
import json
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

KEY = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
ROOT = Path(__file__).resolve().parents[2]
UI = "http://127.0.0.1:5199/ui/"
MOCK = "http://127.0.0.1:5299"
key = json.loads(KEY.read_text())
MY_DID = key["did"]
SECRET_D = key["privateKeyJwk"]["d"]

fails = []


def check(cond, msg):
    print(("OK   " if cond else "FAIL ") + msg)
    if not cond:
        fails.append(msg)


def mock(path, method="GET"):
    req = urllib.request.Request(MOCK + path, method=method, data=b"" if method == "POST" else None)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def toast_text(page):
    return " | ".join(page.locator("#toasts .toast").all_inner_texts())


def send_confirm(page):
    dlg = page.locator("#dlg")
    dlg.get_by_role("button", name="İmzala ve gönder").click()


info = mock("/__mock/info")
with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 960}, accept_downloads=True, locale="tr-TR")
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type in ("error",) else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.goto(UI)
    page.locator("#conn", has_text="yerel köprü").wait_for(timeout=15000)
    page.wait_for_timeout(1500)
    check("TEST MODU" in page.inner_text("footer"), "test modu etkin (sahte hakem)")
    refv = page.locator("#stats .stat-value.big").text_content().strip()
    check(refv.replace(".", "", 1).isdigit(), f"referans okundu: {refv}")

    book = page.inner_text("#book")
    check("9.99" not in book, "imzasi bozuk teklif defterde yok")
    page.wait_for_timeout(1500)
    check("0.33" in page.inner_text("#book"), "hakemin kayıtlı dediği ek odadaki teklif de okunuyor")
    check("0.70" not in book, "karsi imzali teklif defterde yok")
    foot = " ".join(page.locator("#bookFoot .foot-count").all_text_contents())
    for want in ["sonuçlanmış 1", "bant dışı 1", "başkasına ayrılmış 1", "imzası geçersiz 1"]:
        check(want in foot, f"defter sayacı: {want}")
    tight = page.locator("#book .tight-mark").count()
    # Sahte sunucu baslarken until == sonraki tur olan bir teklif koyar. Arada 5 dakikalik tur siniri gectiyse
    # o teklif "sinirda" degil "suresi gecmis" sayilir; ikisinden biri dogru olmali.
    check(("süresi geçmiş 1" in foot and tight >= 1) or ("süresi geçmiş 2" in foot and tight == 0),
          f"süresi geçmiş / sınırda ayrımı (işaret {tight}; {foot})")
    # ayni fiyat seviyesi birlesmesi: maker 3 ve 4 ayni fiyatta satis (1.20 + 0.50 = 1.70)
    check("1.70" in book, "ayni fiyattaki iki satis tek seviyede (1.70)")
    page.screenshot(path=str(OUT / "01-ilk.png"), full_page=True)

    # ---- dil secimi: EN'e gec, metinler degismeli; kontrol listesi de Ingilizce; TR'ye don
    page.locator("#langSwitch button[data-lang=en]").click()
    page.locator(".panel-title", has_text="Order book").wait_for(timeout=3000)
    check(page.locator("html").get_attribute("lang") == "en", "EN: html lang=en")
    check("Reference" in page.locator("#stats").text_content(), "EN: üst bant İngilizce")
    check(page.locator("#idChip").text_content().strip() == "Choose identity", "EN: kimlik düğmesi İngilizce")
    page.locator("#ticket input.input").nth(1).fill("1.00")
    page.locator("#ticket input.input").nth(1).blur()
    page.wait_for_timeout(300)
    ck = page.locator("#ticketSummary .checks").text_content()
    check("Lock" in ck and "Kilit" not in ck, "EN: kontrol listesi İngilizce")
    page.screenshot(path=str(OUT / "01b-en.png"), full_page=True)
    page.reload()
    page.locator(".panel-title", has_text="Order book").wait_for(timeout=5000)
    check(True, "EN seçimi yenilemeden sonra da duruyor")
    page.locator("#langSwitch button[data-lang=tr]").click()
    page.locator(".panel-title", has_text="Emir defteri").wait_for(timeout=3000)
    page.locator("#ticket input.input").nth(1).fill("")
    page.locator("#ticket input.input").nth(1).blur()
    page.locator("#conn", has_text="yerel köprü").wait_for(timeout=15000)

    # ---- kimlik: dosyadan
    page.click("#idChip")
    page.set_input_files("#dlg input[type=file]", str(KEY))
    page.locator("#idChip", has_text="Anahtar").wait_for(timeout=5000)
    check(MY_DID[-4:] in page.inner_text("#idChip"), "anahtar yuklendi, DID ust cubukta")

    # ---- kayit
    page.get_by_role("button", name="Kayıt ol (10.000 POLF)").click()
    page.wait_for_selector("#dlg[open]")
    dtext = page.locator("#dlg").text_content()
    check('"t":"owner"' in dtext and MY_DID in dtext, "kayit onizlemesi owner metni ve DID'i gosteriyor")
    page.screenshot(path=str(OUT / "02-kayit-onay.png"))
    send_confirm(page)
    page.locator("#toasts .toast", has_text="Sunucu aldı").first.wait_for(timeout=5000)
    check(True, "kayit gonderildi: " + toast_text(page))

    # ---- teklif (SHORT)
    page.get_by_role("button", name="SHORT · satış").click()
    ref = page.inner_text("#stats .stat-value.big").strip()
    px = f"{float(ref) + 0.20:.2f}"
    price_in = page.locator("#ticket input.input").nth(0)
    price_in.fill(px)
    page.get_by_role("button", name="%25").click()
    qty = page.locator("#ticket input.input").nth(1).input_value()
    check(qty != "" and float(qty) >= 0.1, f"%25 miktari hesaplandi: {qty}")
    page.screenshot(path=str(OUT / "03-bilet.png"), full_page=True)
    page.get_by_role("button", name="İmzala ve teklif ver (SHORT)").click()
    page.wait_for_selector("#dlg[open]")
    dtext = page.locator("#dlg").text_content()
    check("Gönderim öncesi kontrol" in dtext, "teklif onayinda kontrol listesi var")
    page.screenshot(path=str(OUT / "04-teklif-onay.png"))
    send_confirm(page)
    page.wait_for_timeout(600)
    check("Sunucu aldı (200)" in toast_text(page), "teklif gonderildi")

    # kendi teklifimiz deftere dusmeli (1 sn okuma araligi)
    page.wait_for_timeout(2500)
    check(px in page.inner_text("#book"), f"kendi teklifimiz defterde gorunuyor ({px})")

    # ---- kabul: en iyi satis seviyesini ac, Al
    # en iyi satis seviyesinden baslayarak, kendimize ait olmayan ilk teklifi ac (kendi teklifimizde dugme kapali olmali)
    asks = page.locator("#book .lvl.ask")
    best_px, own_disabled_seen = None, False
    for i in range(asks.count() - 1, -1, -1):
        lvl = page.locator("#book .lvl.ask").nth(i)
        best_px = lvl.locator(".px").inner_text()
        lvl.click()
        items = page.locator("#book .offer-list .offer-item")
        for j in range(items.count()):
            it = items.nth(j)
            btn = it.locator("button")
            if it.locator(".pill.own").count():
                own_disabled_seen = own_disabled_seen or btn.is_disabled()
                continue
            if btn.is_enabled():
                btn.click()
                break
        else:
            continue
        break
    check(True, f"kabul icin seviye {best_px}; kendi teklifinde dugme kapali: {own_disabled_seen}")
    page.wait_for_selector("#dlg[open]")
    dtext = page.locator("#dlg").text_content()
    check("Tahmini ücretin" in dtext and "Kabul" in dtext, f"kabul onayi acildi ({best_px})")
    page.screenshot(path=str(OUT / "05-kabul-onay.png"))
    send_confirm(page)
    page.wait_for_timeout(600)
    check("Sunucu aldı (200)" in toast_text(page), "kabul (trade) gonderildi")

    # ---- ikinci kabul: hakemin "funds" ile dusurecegi teklif (miktar 0.11) -> kayit kesinlesmeli
    found = False
    for i in range(page.locator("#book .lvl.ask").count()):
        lvl = page.locator("#book .lvl.ask").nth(i)
        lvl.click()
        page.wait_for_timeout(200)
        it = page.locator("#book .offer-list .offer-item", has_text="0.11 @")
        if it.count():
            it.first.locator("button").click()
            found = True
            break
        lvl.click()
    check(found, "0.11'lik (funds ile düşecek) teklif bulundu")
    page.wait_for_selector("#dlg[open]")
    send_confirm(page)
    page.wait_for_timeout(600)

    # ---- sahte hakem turu ve sonuc
    sw = mock("/__mock/sweep", "POST")
    page.wait_for_timeout(3000)
    page.get_by_role("button", name="İşlemlerim").click()
    tab = page.locator("#tabBody").text_content()
    check("kayıtlı (kesin" in tab, "kayıt: funds ile düşen kabul sayesinde kesin")
    check("void · funds" in tab, "ikinci kabul void · funds")
    check("≈ settled (çıkarım" in tab, f"kabul edilen işlem ≈ settled (çıkarım; tur {sw['n']})")
    check("karşı imza görülmedi" in tab, "kendi teklifimiz: karşı imza görülmedi")
    page.get_by_role("button", name="Tahmini defterim").click()
    heads = page.locator("#tabBody table.ledger th").all_text_contents()
    check("Doğrudan doğrulanan işlemlerden hesaplanan bakiye" in heads and "Çıkarımlar dahil tahmini bakiye" in heads, "defter: iki bakiye sütunu")
    rows = [r.locator("td").all_text_contents() for r in page.locator("#tabBody table.ledger tbody tr").all()]
    sc = [r for r in rows if r and r[0] == "Settled işlem"][0]
    check(sc[1] == "0" and sc[2] == "1", f"çıkarımla settled işlem yalnız sağ sütunda ({sc})")
    cash = [r for r in rows if r and r[0] == "Nakit"][0]
    check(cash[1].startswith("10,000.00") and not cash[2].startswith("10,000.00"), f"doğrulanan nakit 10.000, çıkarım dahil daha az ({cash})")
    check("nakit: doğrulanan" in page.locator("#ticketMeta").text_content(), "bilet: iki nakit birlikte gösteriliyor")
    ck = page.locator("#ticketSummary .checks").text_content()
    check("Geçmiş eksikliği" in ck, "kontrol listesinde geçmiş eksikliği maddesi var")
    tape = page.locator(".tape-rows").text_content()
    check("≈settled" in tape and "settled" in tape.replace("≈settled", ""), "son işlemler: listelenen 'settled' ve çıkarım '≈settled' ayrı")
    page.screenshot(path=str(OUT / "06-defterim.png"), full_page=True)
    page.get_by_role("button", name="İşlemlerim").click()
    page.screenshot(path=str(OUT / "07-islemlerim.png"), full_page=True)

    # ---- kanit indirme
    with page.expect_download() as dl:
        page.get_by_role("button", name="Kanıtı indir (JSONL)").click()
    ev = Path(dl.value.path()).read_text()
    check(SECRET_D not in ev and "privateKeyJwk" not in ev, "kanit dosyasinda ozel anahtar yok")
    check(len([l for l in ev.splitlines() if l.strip()]) == 4, "kanit dosyasinda 4 gonderim")

    # ---- kacirilan mesaj benzetimi: gonderdigimiz trade'ler okumadan gizlenir, sayfa yenilenir
    mock("/__mock/hide-posted-trades", "POST")
    page.reload()
    page.locator("#conn", has_text="yerel köprü").wait_for(timeout=15000)
    page.click("#idChip")
    page.set_input_files("#dlg input[type=file]", str(KEY))
    page.locator("#idChip", has_text="Anahtar").wait_for(timeout=5000)
    page.wait_for_timeout(2500)
    page.get_by_role("button", name="Tahmini defterim").click()
    rows2 = [r.locator("td").all_text_contents() for r in page.locator("#tabBody table.ledger tbody tr").all()]
    sc2 = [r for r in rows2 if r and r[0] == "Settled işlem"][0]
    check(sc2[2] == "1", f"okumada görülmeyen kendi işlemimiz kanıt kaydından bulundu ({sc2})")
    page.get_by_role("button", name="İşlemlerim").click()
    tab2 = page.locator("#tabBody").text_content()
    check("void · funds" in tab2 and "kayıtlı (kesin" in tab2, "yenilemeden sonra da kayıt kesin, funds sonucu duruyor")

    # ---- harici imza modu
    page.click("#idChip")
    page.get_by_role("button", name="Kimliği / anahtarı unut").click()
    page.click("#idChip")
    page.fill("#dlg input[placeholder^='did:key']", MY_DID)
    page.get_by_role("button", name="Harici imza (anahtar tarayıcıya girmez)").click()
    page.get_by_role("button", name="Kayıt ol (10.000 POLF)").click()
    page.wait_for_selector("#dlg[open]")
    send_confirm(page)
    page.locator("#dlg[open] .dlg-title", has_text="Harici imza").wait_for(timeout=5000)
    payload = page.locator("#dlg .code").first.inner_text()
    page.screenshot(path=str(OUT / "08-harici-imza.png"))
    # yanlis imza reddedilmeli
    page.fill("#dlg input[placeholder^='86']", "A" * 85 + "A")
    page.get_by_role("button", name="Doğrula ve devam et").click()
    check("doğrulamıyor" in page.locator("#dlg").text_content(), "yanlis harici imza reddedildi")
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt") as f:
        f.write(payload)
        tmp = f.name
    sig = subprocess.check_output(["node", str(ROOT / "tools/ui-test/verify-posted.mjs"), "--imzala", str(KEY), tmp], text=True).strip()
    page.fill("#dlg input[placeholder^='86']", sig)
    page.get_by_role("button", name="Doğrula ve devam et").click()
    page.wait_for_timeout(800)
    check("Sunucu aldı (200)" in toast_text(page), "harici imzayla gonderildi")

    # ---- hakem mesajlarını indir
    page.get_by_role("button", name="Hakkında").click()
    with page.expect_download() as dl2:
        page.get_by_role("button", name="Hakem mesajlarını indir (JSON)").click()
    raw = json.loads(Path(dl2.value.path()).read_text())
    check(all(len(raw[k]) >= 1 for k in ("price", "flow", "positions")), "hakem mesajları indirildi (price/flow/positions)")
    about = page.locator("#tabBody").text_content()
    check("mock-extra" in about, "Hakkında: ek oda listeleniyor")
    check("Tur eşleme denetimi" in about, f"Hakkında: tur eşleme denetimi var ({about[about.find('Tur eşleme'):][:90]})")

    # ---- depolama: anahtar yok
    ls = page.evaluate("JSON.stringify(Object.assign({}, localStorage))")
    check(SECRET_D not in ls and "privateKeyJwk" not in ls, "localStorage'da ozel anahtar yok")

    # ---- mobil gorunum
    m = browser.new_page(viewport={"width": 390, "height": 844})
    m.goto(UI)
    m.wait_for_timeout(2500)
    sw_ = m.evaluate("document.documentElement.scrollWidth")
    check(sw_ <= 390, f"mobilde yatay tasma yok (scrollWidth {sw_})")
    m.screenshot(path=str(OUT / "09-mobil.png"), full_page=True)

    check(not errors, "tarayici konsolunda hata yok" + ("" if not errors else ": " + " || ".join(errors[:5])))
    browser.close()

# ---- gonderilenleri cekirdekle bagimsiz dogrula
posted = urllib.request.urlopen(MOCK + "/__mock/posted").read()
pp = OUT / "posted.json"
pp.write_bytes(posted)
rows = json.loads(subprocess.check_output(["node", str(ROOT / "tools/ui-test/verify-posted.mjs"), str(pp)], text=True))
check(len(rows) == 5, f"sunucuya 5 kayit geldi ({len(rows)})")
check(all(r["roomSig"] for r in rows), "tum oda imzalari gecerli")
check(all(r["from"] == MY_DID for r in rows), "hepsi test DID'inden")
kinds = [(r["room"], r["t"]) for r in rows]
check(kinds.count(("close1", "owner")) == 2, "iki kayit mesaji close1'de")
off = [r for r in rows if r["t"] == "close-call.offer.v1"]
check(len(off) == 1 and off[0]["room"] == "close1-offers" and off[0]["makerSig"], "teklif close1-offers'ta, maker imzasi gecerli")
check(off and off[0]["terms"]["side"] == "sell", "teklif yonu SHORT (sell)")
tr = [r for r in rows if r["t"] == "trade"]
check(len(tr) == 2 and all(x["room"] == "close1" and x["tradeSigs"] and x["taker"] == MY_DID for x in tr), "iki trade close1'de, imzalar gecerli, taker biziz")
check(tr and all(x["terms"]["side"] == "sell" for x in tr), "kabul edilen teklifler satis teklifi (biz long)")

print("\nSONUC:", "GECTI" if not fails else f"{len(fails)} HATA")
sys.exit(1 if fails else 0)

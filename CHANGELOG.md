# Değişiklikler

## v0.3.5 (27 Eylül 2026, komut satırı)

1. **Bilerek kendinle işlem: `kabul --kendinle`.** Kural 12 aynı anahtarın iki tarafta olduğu işlemi tanımlıyor: iki tarafın ücreti ödenir, pozisyon değişmez, hakem yalnız ücretlerin karşılanıp karşılanmadığına bakar. Kendi teklifini kabul etmek yalnız bu bayrakla açılır; bayraksız komut ve arayüz eskisi gibi reddeder. Kullanım amacı hesabın bakiyesini karşı taraftan bağımsız sınamak.
2. **İşlem sonucunu okuma: `durum --id <işlem-id>`.** Bu klasörden gönderilen işlemin zamanını `kayitlar.jsonl`'den alır (ya da `--zaman <ISO>`), hakem akışında settled / ≈ settled / void / bekleniyor / bilinmiyor olarak gösterir. 269. turun gerçek hakem mesajlarıyla denendi.
3. **Test:** kendinle işlem testi eklendi (resmî fold'un kopyasında settled, pozisyon 0, ücret 0,44906 POLF). 21 test.
4. **Canlıda doğrulandı:** 27 Eylül'de komut satırından gönderilen kendinle işlemlerin beşi hakem listesinde settled göründü (649, 650, 651, 653, 654. turlar). Arayüzde değişiklik yok; sürüm numarası paketle aynı olsun diye 0.3.5 yapıldı.

## v0.3.4 (26 Eylül 2026)

Canlı kayıt ve ilk kabul denemesinden sonra.

1. **Kendi işlemin kayıttan geri kuruluyor.** Arayüzün gönderdiği her kabul (`trade`), sunucunun verdiği kayıt numarası ve zamanıyla (`posted.seq`, `posted.ts`) gönderim kaydından yeniden okunuyor ve imzası doğrulanıyor. close1 kalabalık olduğu için okuma bu mesajı kaçırsa bile işlem "İşlemlerim"de ve hakem sonucunda görünüyor.
2. **Kayıt satırı kesin sonucu gösteriyor.** Kendi işlemin hakem listesinde not_owner'dan sonraki bir nedenle (ör. `void · funds`) görünürse kayıt "kayıtlı (kesin)" olur; kontrol listesindeki "?" kalkar.
3. **Uçtan uca test 57 kontrol.** Sahte sunucuya "gönderilen işlemi okumada gizle" modu eklendi; 2. madde bu modda sınanıyor.
4. **GitHub'a hazırlık.** `.gitignore` anahtar dosyalarını ve komut satırının yerel kayıtlarını dışarıda tutar. Kökteki `index.html` `ui/`'ye yönlendirir, `.nojekyll` eklendi (GitHub Pages için). README yeniden düzenlendi, değişiklikler bu dosyaya taşındı, işaretli ekran görüntüleri `docs/img/` altında.
5. **Doğrudan bağlantı kurulamazsa açıklama.** Sayfa yerel köprü olmadan açıldığında (ör. GitHub Pages) technocore.chat'e ulaşılamazsa üst çubukta "doğrudan bağlantı yok (CORS ya da ağ)", emir defterinde yerel köprü komutu gösterilir. Önceden yalnız "Failed to fetch" yazıyordu.

## v0.3.3 (inceleme düzeltmeleri)

1. **İki ayrı bakiye.**
   - **Doğrudan doğrulanan işlemlerden hesaplanan bakiye:** Yalnız hakem listesinde doğrudan görülen işlemler.
   - **Çıkarımlar dahil tahmini bakiye:** Ayrıca "≈ settled" sayılan işlemler.
   - Hiçbiri hakemin kesin hesap bakiyesi değil. Bu tarayıcının görmediği bir işlem (başka cihaz, okunmayan oda, kaçırılan mesaj) teminat bağlamış olabilir.
2. **Bakiye kontrolü iki bakiyede de çalışıyor.** Kontrol listesinde kötü sonuç esas alınıyor. İkisinden geçmek hakemin kabul edeceğini garanti etmiyor. Maks miktar, nakdi az olan bakiyeyle hesaplanıyor.
3. **"Geçmiş eksikliği" maddesi.** Kontrol listesinde ve defterde gösteriliyor. Kapsamı: okunan odalarda kaçırılan mesaj, okunmayan kayıtlı oda, sonucu bilinmeyen kendi işlemin. Hiçbiri yoksa "eksiklik saptanmadı; görülmeyen işlemler bilinemez" yazıyor, "tamam" demiyor.
4. **Kayıt durumu iki kademe.** Kurallardaki kontrol sırası: shape → not_owner → taker → settled → expired → locked → limits → funds.
   - **Kesin:** İşlemin hakem listesinde settled görünüyor ya da not_owner'dan sonraki bir nedenle void. Ya da DID mints listesinde.
   - **Çıkarım:** İşlemin "≈ settled" ya da bu tarayıcıdan gönderilen kayıt o turda işlendi. Çıkarımla kayıt, kontrol listesinde "?" olarak kalıyor.

## v0.3.2 (canlı hakem mesajlarına göre)

Kaynak: 26 Eylül, 269–271. turların hakem mesajları (`test/vectors/referee-live-269-271.json`; 9 hakem imzası da doğrulanıyor).

1. **Akış mesajının gerçek yapısı:**
   - `settled`: işlem kimliklerinin listesi.
   - `void`: `[kimlik, neden]` çiftlerinin listesi. Görülen nedenler: funds, limits, expired, not_owner, settled (aynı kimlik daha önce sonuçlandı).
   - `mints`: yeni kayıtların DID listesi.
   - `omitted`: yayımlanmayan öğe sayıları, örneğin `{mints: 3423, settled: 1730, void: 10}`.
   - Diğer alanlar: `rooms` (yeni kayıtlı odalar), `missed`, `unlisted`.
   - Çekirdek bunları okuyor: `flowEntries`, `flowListComplete`, `sweepOfTime`, `tradeStatus`, `flowRooms`. `findInFlow` ve kontrol listesinin "daha önce sonuçlandı mı" maddesi artık bu listelere bakıyor.
2. **Fiyat mesajı:** `applied` önceki turun referansı; `for` bir sonraki tur (bant onun için). Testte doğrulanıyor.
3. **İşlem durumları:** Arayüzde "settled" (listede), "≈ settled (çıkarım)", "void · neden", "tur n bekleniyor" ve "bilinmiyor". Aynı teklifi başka bir taker önce kabul ettiyse "≈ void" olarak işaretleniyor.
4. **Kayıt durumu:** Çıkarımla gösteriliyor. Bekleyen işlemler bakiyeye katılmadığı için kontrol listesine ayrıca bir uyarı eklendi.
5. **Gönderim yanıtı:** Arayüz POST'u `?format=json` ile yapıyor; sunucunun verdiği kayıt numarası ve zamanı (`posted.seq`, `posted.ts`) kanıt kaydına giriyor. Komut satırı eskisi gibi.
6. **Hakemin kayıtlı dediği diğer odalar:** Bunlar da (en çok 10, 30 sn arayla) okunuyor. Bir teklifini kabul eden taker trade'i oraya yazabilir. Canlıda görülen: close1-offers (270. turdan beri kayıtlı), bae-c1.

## v0.3.1

1. **TR / EN seçimi:** Sağ üstte. Seçim tarayıcıda hatırlanır; ilk açılışta tarayıcının diline bakılır. Gönderim öncesi kontrol listesi de seçilen dilde (`preflight` artık `lang` alıyor; komut satırı Türkçe ve ASCII kalıyor).
2. **Grafik ölçeği:** Ölçek artık referans çizgisine göre. ±%5 bant ölçeğe sığmıyorsa kırpılıyor ve değerleri grafiğin sağ üstünde yazıyor.
3. **Hakem mesajlarını indirme:** Hakkında sekmesinde bir düğme. Son fiyat, akış ve pozisyon mesajlarını hakem imzası doğrulanmış haliyle JSON olarak indirir.
4. **Son işlemler:** Fiyat ve miktar iki ondalıkla gösteriliyor.

## v0.3

1. **Tarayıcı arayüzü eklendi:** `ui/`.
2. **Kontrol listesi Türkçe karakterli:** Komut satırı PowerShell 5.1 konsolunda bozulmasın diye bunları ASCII'ye çevirerek yazar. Tutarlar sondaki sıfırlar atılarak gösterilir (277.752000 yerine 277.752).
3. **`imzala` BOM'u temizliyor:** Not Defteri'nin eklediği baştaki BOM imzalanan metinden atılır.
4. **Test yardımcıları `tools/ui-test/` altında:** sahte technocore sunucusu ve uçtan uca tarayıcı testi. `npm.cmd test` bunları çalıştırmaz.

## v0.2 (inceleme düzeltmeleri)

1. **Maks miktar kapanış senaryosuna göre.** `maxQty`, tur kapanışının referanstan en fazla `closeWidth` kadar (varsayılan %2) sapacağını varsayıp en kötü ücreti hesaba katar.
2. **Defterde aynı fiyat tek seviye.** "225" ve "225.00" aynı seviyede birleşir; imzalı metne dokunulmaz.
3. **İki tur kavramı ayrı:** `lastScheduledSweep` ve `nextSweep`. `until < nextSweep` süresi geçmiş, `until == nextSweep` "sınırda".
4. **Gönderim öncesi kontrol listesi** (`preflight`). HATA varsa `--gonder` verilse bile gönderilmez.
5. **Nonce milisaniye** (imzala.js ile aynı birim).
6. **Tam close1 kaydı pakette** (`data/`).

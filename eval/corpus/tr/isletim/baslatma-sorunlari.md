# Başlatma sorunları

Bu sayfa sunucunun hiç ayağa kalkmadığı ya da kalkıp hazır duruma gelmediği durumları kapsar. Ayakta
olan bir kurulumda gönderimlerin ulaşmaması bambaşka bir sorundur ve gönderim sorunlarının giderilmesi
sayfasında ele alınır.

İlk komut her zaman aynıdır:

```bash
halyardctl doctor
```

Yazmaya çalışmaz, birkaç saniye sürer ve aşağıdakilerin yarısını eler.

## `HLY-5008` — şema sürümü ikiliden ileride

Veritabanındaki şema, çalıştırmaya çalıştığınız ikilinin beklediğinden yenidir. Sunucu başlamayı
reddeder; yerleri değişmiş sütunlara sorgu göndermektense durmayı tercih eder.

Bu neredeyse her zaman geri alınmış bir sürüm yükseltmesinin sonucudur: yeni ikili çalışmış, göçleri
uygulamış, sonra bir aksaklık yüzünden eski imaja dönülmüştür. Halyard'ın geri göçü yoktur ve
üretilmesi de planlanmamaktadır.

İki çıkış yolu vardır. İleri gitmek — ikiliyi yeniden yükseltip sorunu orada çözmek — ki tercih edilen
budur. Ya da yükseltmeden önce alınmış bir yedekten geri dönmek; bu durumda yükseltmeden sonra
yayımlanan olayları kaybedersiniz.

## `HLY-5030` — göç başarısız oldu

İleti, başarısız olan göçün adını verir. Veritabanı, temiz biçimde uygulanmış son göçün bulunduğu
noktada kalır; yarım uygulanmış bir göç bırakılmaz.

En sık iki neden: disk dolmuştur, ya da göç uzun bir tablo üzerinde çalışırken başka bir işlemin
tuttuğu kilidi bekleyip zaman aşımına uğramıştır. İkincisi için doğru davranış, uzun süren işlemi
bulup bitirmek ve göçü yeniden çalıştırmaktır:

```sql
SELECT pid, state, wait_event_type, left(query, 80)
FROM pg_stat_activity
WHERE datname = 'halyard' AND state <> 'idle'
ORDER BY query_start;
```

Kapsayıcıyı döngü hâlinde yeniden başlatmak yardımcı olmaz ve günlükleri, gerçek nedeni bulmayı
zorlaştıracak kadar doldurur.

## `HLY-3001` ve `HLY-3002` — imzalama yapılandırması

`HLY-3001`, `HALYARD_SIGNING_SECRET` değerinin eksik ya da 32 bayttan kısa olduğu anlamına gelir.
`HLY-3002`, algoritma `ed25519` iken `HALYARD_SIGNING_PRIVATE_KEY_PATH` yolundaki dosyanın okunamadığını
ya da PKCS#8 biçiminde olmadığını söyler.

İkisi de sunucuyu başlatmaz. Bu kasıtlıdır: imzalanmamış gönderim yapan bir Halyard, alıcı tarafında
hiçbir uyarı üretmeden güvenlik modelini ortadan kaldırır.

Dosya izinlerini de denetleyin. `ProtectSystem=strict` altında çalışan bir systemd birimi, anahtar
dosyası `ReadWritePaths` ya da okunabilir bir yol altında değilse dosyayı hiç göremez ve hata, izin
hatası değil "dosya yok" gibi görünür.

## `/readyz` `503` yanıtlıyor ama süreç ayakta

`/healthz` sürecin ayakta olduğunu, `/readyz` ise hizmet verebilir olduğunu söyler. Aradaki farkın
sebebi iki şeyden biridir ve yanıt gövdesi hangisi olduğunu söyler: veritabanına ulaşılamıyordur
(`HLY-5002`) ya da şema beklenen sürümde değildir.

Yük dengeleyicinizi `/readyz` ucuna, süreç denetleyicinizi `/healthz` ucuna bağlayın. İkisini de aynı
uca bağlarsanız, veritabanının birkaç saniyelik erişilemezliği bütün kopyaların yeniden
başlatılmasıyla sonuçlanır.

## Kuyruk büyüyor ama hiçbir deneme yapılmıyor

Saat kayması. Süreç saati veritabanı sunucusunun saatinden ileride olduğunda, yazılan `next_attempt_at`
değerleri veritabanı açısından gelecekte kalır ve hiçbir satır üstlenilebilir görünmez. Belirti tam
olarak budur: işçiler boşta, kuyruk derinliği artıyor, hata yok.

`halyardctl doctor` 2.7.0 sürümünden beri bu karşılaştırmayı yapar. Daha eski bir sürümdeyseniz
karşılaştırmayı elle yapabilirsiniz:

```bash
date -u +%s && psql "$HALYARD_DATABASE_URL" -tAc "SELECT extract(epoch from now())::bigint"
```

Kalıcı çözüm, sunucuya ve veritabanı makinesine NTP kurmaktır; iki saniyeden büyük her fark bu belirtiyi
üretmeye adaydır.

## `HLY-5011` — veri dizini yazılabilir değil

`HALYARD_DATA_DIR` yazılamıyor. Büyük gövdeler havuza yazılamayacağı için sunucu yazma isteklerini
sessizce gövde düşürmek yerine reddeder.

Dizinin sahipliğini ve systemd biriminin `ReadWritePaths` listesini denetleyin. Kapsayıcıda
çalışıyorsanız, bağlanan birimin salt okunur bağlanmış olması da aynı hatayı üretir.

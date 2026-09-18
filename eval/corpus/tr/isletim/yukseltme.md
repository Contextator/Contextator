# Sürüm yükseltme

Halyard, bir ana sürüm içinde ileriye doğru uyumludur: 2.7 ikilisi 2.5 şemasını okur ve göçlerini kendisi
uygular. Geriye doğru uyumlu değildir. Bu iki cümle, aşağıdaki her şeyin gerekçesidir.

## Yükseltmenin sırası

1. Sürüm notlarını okuyun. Özellikle kaldırılmış ortam değişkenleri ve davranış değişiklikleri
   bölümlerini; 2.6.3'teki `X-Halyard-Attempt` düzeltmesi gibi bir değişiklik, alıcı tarafında uygulanmış
   bir geçici çözümü bozabilir.
2. Yedek alın. Veritabanı önce, yük havuzu sonra.
3. Tek bir kopyayı yükseltin ve `/readyz` yanıtını bekleyin.
4. `halyardctl doctor` çalıştırın.
5. Kalan kopyaları yükseltin.

Üçüncü adımdaki tek kopya, göçleri uygulayacak olan kopyadır. Diğer kopyalar bu sırada eski ikiliyle
çalışmaya devam eder ve yeni şema üzerinde sorun çıkarmaz; ana sürüm içindeki göçler eskiye dokunmayacak
biçimde yazılır.

## Geri alma diye bir şey yok

Göçleri uygulanmış bir veritabanına eski ikiliyi geri koyduğunuzda `HLY-5008` alırsınız ve sunucu
başlamaz. Bu bir kusur değil, kasıtlı bir durdurmadır; alternatifi, yerleri değişmiş sütunlara sorgu
gönderen bir sunucudur.

Dolayısıyla yükseltmeden dönüş yolu, yedekten geri yüklemedir ve yükseltmeden sonra yayımlanmış olayları
kaybetmek anlamına gelir. Bu gerçek, yükseltmeyi düşük trafikli bir saatte ve yedeği aldıktan hemen
sonra yapmanın asıl sebebidir.

## 3.0.0'a hazırlık

3.0.0, iki ortam değişkenini kaldırıyor ve bunlar hâlâ tanımlıysa sunucu başlamıyor:

- `HALYARD_WORKER_COUNT` — 2.4.0'dan beri `HALYARD_DISPATCH_CONCURRENCY` ile değiştirildi, 2.6.0'dan beri
  tümüyle yok sayılıyor.
- `HALYARD_WEBHOOK_SECRET` — 2.2.0'da `HALYARD_SIGNING_SECRET` oldu; hâlâ okunuyor ve her başlangıçta
  uyarı yazıyor.

İkisini de yükseltmeden önce, 2.7 üzerindeyken temizleyin. Uyarı satırlarını günlüklerinizde aratmak
bunun için yeterlidir ve bu, 3.0.0'a geçişte yaşanabilecek tek kesintiyi önceden ortadan kaldırır.

Ayrıca `GET /v1/deliveries` artık `offset` kabul etmiyor. Sayfalama yapan betikleriniz varsa imleç
tabanlı sayfalamaya geçirin; 2.7 zaten imleç desteklediği için bu değişikliği yükseltmeden önce
yapabilirsiniz.

PostgreSQL 13 desteği de kalkıyor. 14 ya da üstüne geçmeniz gerekiyorsa, bu geçişi Halyard
yükseltmesiyle aynı bakım penceresine koymayın; iki ayrı değişikliğin aynı anda yapılması, bir şey ters
gittiğinde hangisinin sorumlu olduğunu belirsizleştirir.

## Kesintisiz yükseltme

Kopyalar durumsuz olduğu için sıralı yükseltme sorunsuzdur. Tek dikkat edilecek nokta, kapanma
süresinin `HALYARD_DRAIN_TIMEOUT` değerinden uzun tanınmasıdır; systemd'de `TimeoutStopSec`,
Kubernetes'te `terminationGracePeriodSeconds`. Kısa tanınırsa uçuştaki gönderimler yarıda kesilir;
kaybolmazlar ama kiralamaları dolana kadar yeniden denenemezler, bu da gereksiz bir gecikmedir.

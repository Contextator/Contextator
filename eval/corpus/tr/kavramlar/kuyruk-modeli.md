# Kuyruk modeli

Halyard'ın kuyruğu ayrı bir bileşen değildir. Bekleyen gönderimler PostgreSQL'de sıradan satırlardır ve
kopyalar bu satırları `SELECT … FOR UPDATE SKIP LOCKED` ile üstlenir. Bu sayfa, bu tercihin
sonuçlarının neler olduğunu ve hangi durumlarda hissedileceğini anlatır; çünkü kuyruğun davranışını
anlamadan eşzamanlılık ayarlarını değiştirmek, iyileştirme yerine yer değiştirme üretir.

## Bir gönderimin yaşam döngüsü

Bir olay yayımlandığında, o olaya abone olan her etkin uç nokta için bir gönderim satırı yazılır. Satır
`pending` durumunda doğar ve `next_attempt_at` alanı, olayın `not_before` değeri varsa o ana, yoksa
şimdiye ayarlanır.

Boşta işçisi olan bir kopya, `HALYARD_QUEUE_POLL_INTERVAL` aralıklarıyla, `next_attempt_at` değeri
geçmişte kalmış gönderimleri sorgular. Üstlenilen her satıra bir kiralama yazılır; kiralama, o satırın
belirli bir süre boyunca başka hiçbir kopya tarafından alınamayacağı anlamına gelir. Deneme yapılır,
sonuç yazılır, kiralama bırakılır.

Deneme başarısız olduğunda satır `pending` durumuna geri döner ve `next_attempt_at`, üstel geri çekilme
kuralına göre ileriye ötelenir. Deneme sayısı `HALYARD_MAX_ATTEMPTS` değerine ulaştığında satır kalıcı
olarak `failed` olur ve yalnızca elle yeniden gönderimle canlandırılabilir.

## Kiralamaların süresi neden var

Kiralamalar süresizdir denemez, çünkü kiralamayı alan kopya çökebilir. Süresi dolmuş bir kiralama,
satırın yeniden üstlenilebilir hâle gelmesini sağlar. Bunun kaçınılmaz sonucu şudur: ağ bölünmesi
yaşayan — yani ölmemiş ama ulaşılamayan — bir kopya, kiralaması dolmuş bir gönderimi hâlâ deniyor
olabilir ve aynı gönderim ikinci kez denenebilir.

Bu, "en az bir kez" güvencesinin doğduğu yerdir ve kapatılabilir bir davranış değildir. Alıcınızın
`X-Halyard-Delivery-Id` başlığına bakarak yinelenen istekleri ayıklaması gerekir.

## `SKIP LOCKED` ne getirir, ne getirmez

Getirdiği şey, kopyaların birbirini beklememesidir. Kilitlenmiş bir satıra rastlayan sorgu, o satırın
serbest kalmasını beklemek yerine bir sonrakine geçer; böylece yavaş bir alıcıya yapılan gönderim,
kuyruğun geri kalanını durdurmaz.

Getirmediği şey sıradır. Kuyruktan çekme sırası, yazılma sırasıyla aynı olmak zorunda değildir ve
yeniden denemeler bu sırayı iyice bozar. Sıralı teslim isteyen bir tasarımın Halyard'ın kuyruğundan
alabileceği bir güvence yoktur; yükünüzün içine bir sürüm numarası koymak ve alıcıda eskiyeni atmak,
kuyruğu sıralı hâle getirmeye çalışmaktan hem daha ucuz hem de yeniden başlatmalara karşı daha
dayanıklıdır.

## Kuyruğun ölçeklenebilirliğinin sınırı

Kuyruğun verimi, tek bir PostgreSQL sunucusunun kısa güncelleme işlemleriyle baş edebilme hızıyla
sınırlıdır. Bu, pratikte saniyede binlerce gönderim demektir; yüz binlerce değil. Bu sınırın nerede
olduğunu bilmek önemlidir, çünkü sınıra yaklaşıldığında belirti kuyruk derinliğinin artması değil,
`halyard_queue_oldest_seconds` değerinin işçiler boştayken büyümesidir — yani kopyalar iş bulamıyor
gibi görünürken aslında veritabanı sorguları sıraya girmiştir.

Bu sınıra ulaşmadan önce yapılacak şeyler sırayla şunlardır: uç nokta başına eşzamanlılık sınırı koymak,
yoklama aralığını gereksiz yere küçültmemek, ve bağlantı havuzunun önüne işlem kipinde bir PgBouncer
yerleştirmek. Bunların üçü de kuyruğun kendisini değiştirmeden, veritabanına düşen yükü azaltır.

## Neden ayrı bir kuyruk aracısı yok

Bir kuyruk aracısı eklemek verimi artırırdı; bunu inkâr etmenin anlamı yok. Karşılığında ise yedeklenmesi
gereken ikinci bir durum, izlenmesi gereken ikinci bir sistem ve tutarsız kalabilecek ikinci bir yer
gelirdi. Halyard'ın hedeflediği yük — bir ürünün dışarıya çıkan bildirimleri — için bu değişim hiçbir
zaman yakın bir karar olmadı.

Gerçekten bir aracının gerekli olduğu ölçekteyseniz, kuyruk modelini değiştirmek yerine olayları
Halyard'a ulaşmadan önce bölmek daha iyi çalışır: birden çok Halyard kurulumu, tek bir kurulumun
aracıyla ölçeklenmiş hâlinden hem daha basit hem de arıza yalıtımı açısından daha iyidir.

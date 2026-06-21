package com.academicagent.platform;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;

@SpringBootApplication(scanBasePackages = "com.academicagent.platform")
@EntityScan(basePackages = {
    "com.academicagent.platform.identity.entity",
    "com.academicagent.platform.research.entity"
})
@EnableJpaRepositories(basePackages = {
    "com.academicagent.platform.identity.repository",
    "com.academicagent.platform.research.repository"
})
public class PlatformApplication {

    public static void main(String[] args) {
        SpringApplication.run(PlatformApplication.class, args);
    }
}
